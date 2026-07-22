import { randomUUID } from 'node:crypto';

import { Router, type Router as ExpressRouter } from 'express';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { Database } from '../../db/types';
import {
  coachHasAcceptedBind,
  deleteAttachmentMetadata,
  findAttachment,
  findOwnedAttachment,
  insertAttachment,
  markAttachmentReady,
  serializeAttachment,
  transitionAttachmentStatus,
} from '../../handlers/attachments';
import type { Logger } from '../../logger';
import type { OssService } from '../../services/oss';
import { uuidEquals } from '../../utils/uuid';
import { route, validationEnvelope } from '../http';
import {
  AttachmentIdParamSchema,
  CompleteBodySchema,
  AbortBodySchema,
  CONTENT_TYPE_EXTENSIONS,
  InitiateBodySchema,
  KIND_LIMITS,
} from './schemas';

const PART_URL_TTL_SECONDS = 3600; // 1h invariant — do not extend (spec 004)
const GET_URL_TTL_SECONDS = 900; // 15min invariant — do not extend (spec 004)
const MAX_ACTIVE_UPLOADS_PER_OWNER = 10;

interface UploadsRouterDeps {
  db: Kysely<Database>;
  logger: Logger;
  /** Absent when OSS env vars are not configured (local dev) — routes answer 503. */
  oss?: OssService | undefined;
}

export function uploadsRouter(deps: UploadsRouterDeps): ExpressRouter {
  const router = Router();
  const { db, logger, oss } = deps;

  // OSS env not configured (local dev / misconfig): every /uploads route answers
  // 503 before any validation, per spec 004.
  if (!oss) {
    router.use((_req, res) => {
      res.status(503).json({ error: 'UPLOADS_NOT_CONFIGURED' });
    });
    return router;
  }
  const configuredOss = oss;

  async function verifyCompletedObject(attachment: Awaited<ReturnType<typeof findAttachment>>) {
    if (!attachment) return null;
    const object = await configuredOss.headObject(attachment.oss_key);
    return object;
  }

  async function failSizeVerification(
    attachment: NonNullable<Awaited<ReturnType<typeof findAttachment>>>,
    actualSizeBytes: number | null,
  ): Promise<void> {
    if (actualSizeBytes !== null) {
      try {
        await configuredOss.deleteObject(attachment.oss_key);
      } catch (err) {
        logger.warn({ err, attachmentId: attachment.id }, 'upload_size_mismatch_delete_failed');
      }
    }
    await transitionAttachmentStatus(db, attachment.id, 'completing', 'failed');
  }

  async function deleteRemoteAttachment(
    attachment: NonNullable<Awaited<ReturnType<typeof findAttachment>>>,
  ): Promise<void> {
    if (attachment.oss_upload_id !== null) {
      // The service treats NoSuchUpload as success, so this is safe both for a
      // ready object and for a multipart upload that never completed.
      await configuredOss.abortMultipartUpload(attachment.oss_key, attachment.oss_upload_id);
    }
    // deleteObject likewise treats NoSuchKey as success: failed/aborted rows
    // may already have been cleaned by OSS lifecycle rules.
    await configuredOss.deleteObject(attachment.oss_key);
  }

  async function lockAttachmentForDeletion(
    attachmentId: string,
    ownerId: string,
    claimDeleting: boolean,
  ) {
    return db.transaction().execute(async (trx) => {
      const attachment = await trx
        .selectFrom('attachments')
        .selectAll()
        .where('id', '=', attachmentId)
        .where('owner_id', '=', ownerId)
        .forUpdate()
        .executeTakeFirst();
      if (!attachment) return { outcome: 'not_found' as const };

      const referenced = await trx
        .selectFrom('messages')
        .select('id')
        .where('attachment_id', '=', attachment.id)
        .limit(1)
        .executeTakeFirst();
      if (referenced) return { outcome: 'in_use' as const };

      if (!claimDeleting) {
        return attachment.status === 'deleting'
          ? { outcome: 'claimed' as const, attachment, previousStatus: attachment.status }
          : { outcome: 'invalid_state' as const, attachment };
      }

      if (
        attachment.status === 'deleting' ||
        attachment.status === 'completing' ||
        attachment.status === 'aborting'
      ) {
        return { outcome: 'invalid_state' as const, attachment };
      }

      const claimed = await trx
        .updateTable('attachments')
        .set({ status: 'deleting', updated_at: sql<Date>`now()` })
        .where('id', '=', attachment.id)
        .where('status', '=', attachment.status)
        .returningAll()
        .executeTakeFirst();
      if (!claimed) return { outcome: 'invalid_state' as const, attachment };

      return {
        outcome: 'claimed' as const,
        attachment,
        previousStatus: attachment.status,
      };
    });
  }

  async function attachmentIsReferenced(attachmentId: string): Promise<boolean> {
    const referenced = await db
      .selectFrom('messages')
      .select('id')
      .where('attachment_id', '=', attachmentId)
      .limit(1)
      .executeTakeFirst();
    return referenced !== undefined;
  }

  async function releaseDeletionClaim(
    attachmentId: string,
    previousStatus: NonNullable<Awaited<ReturnType<typeof findAttachment>>>['status'],
  ): Promise<void> {
    if (previousStatus === 'deleting') return;
    await transitionAttachmentStatus(db, attachmentId, 'deleting', previousStatus);
  }

  router.post(
    '/initiate',
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const body = InitiateBodySchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      const limits = KIND_LIMITS[body.data.kind];
      if (!limits.contentTypes.includes(body.data.content_type)) {
        res.status(400).json({
          error: 'UPLOAD_CONTENT_TYPE_MISMATCH',
          kind: body.data.kind,
          allowed_content_types: limits.contentTypes,
        });
        return;
      }
      if (body.data.size_bytes > limits.maxSizeBytes) {
        res.status(400).json({
          error: 'UPLOAD_TOO_LARGE',
          kind: body.data.kind,
          max_size_bytes: limits.maxSizeBytes,
        });
        return;
      }

      const activeUploads = await db
        .selectFrom('attachments')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('owner_id', '=', req.user.id)
        .where('status', 'in', ['uploading', 'completing', 'aborting'])
        .executeTakeFirstOrThrow();
      if (activeUploads.count >= MAX_ACTIVE_UPLOADS_PER_OWNER) {
        res.status(429).json({ error: 'UPLOAD_QUOTA_EXCEEDED' });
        return;
      }

      const extension = CONTENT_TYPE_EXTENSIONS[body.data.content_type];
      if (extension === undefined) {
        // Unreachable while the whitelist and extension map stay in sync.
        res.status(400).json({ error: 'UPLOAD_CONTENT_TYPE_MISMATCH' });
        return;
      }

      let provenance: {
        source_plan_id: string | null;
        source_coach_id: string | null;
        is_unlinked_explicit: boolean;
      } = {
        source_plan_id: null,
        source_coach_id: null,
        is_unlinked_explicit: body.data.set_log_id === undefined,
      };

      // Real gate: a set_video may only link to the uploader's own set log.
      // Capture its coach/plan now; visibility must never depend on a mutable
      // future join or on a SET NULL orphan.
      if (body.data.set_log_id !== undefined) {
        const ownedLog = await db
          .selectFrom('set_logs as sl')
          .innerJoin('plan_exercises as pe', 'pe.id', 'sl.plan_exercise_id')
          .innerJoin('plan_days as pd', 'pd.id', 'pe.plan_day_id')
          .innerJoin('plans as p', 'p.id', 'pd.plan_id')
          .select(['sl.id as id', 'p.id as source_plan_id', 'p.coach_id as source_coach_id'])
          .where('sl.id', '=', body.data.set_log_id)
          .where('sl.student_id', '=', req.user.id)
          .executeTakeFirst();
        if (!ownedLog) {
          res.status(404).json({ error: 'SET_LOG_NOT_FOUND' });
          return;
        }
        provenance = {
          source_plan_id: ownedLog.source_plan_id,
          source_coach_id: ownedLog.source_coach_id,
          is_unlinked_explicit: false,
        };
      }

      const ossKey = `attachments/${req.user.id}/${randomUUID()}${extension}`;
      const uploadId = await oss.initiateMultipartUpload(ossKey, body.data.content_type);

      let attachment: Awaited<ReturnType<typeof insertAttachment>>;
      let partUrls: Awaited<ReturnType<typeof oss.signPartUrls>>;
      try {
        attachment = await insertAttachment(db, {
          owner_id: req.user.id,
          kind: body.data.kind,
          oss_key: ossKey,
          oss_upload_id: uploadId,
          content_type: body.data.content_type,
          size_bytes: body.data.size_bytes,
          filename: body.data.filename ?? null,
          set_log_id: body.data.set_log_id ?? null,
          ...provenance,
          part_count: body.data.part_count,
        });

        partUrls = await oss.signPartUrls(
          ossKey,
          uploadId,
          body.data.part_count,
          PART_URL_TTL_SECONDS,
        );
      } catch (err) {
        // If the DB write itself fails, the client never receives an upload ID;
        // compensate immediately rather than leaving an inaccessible OSS upload.
        try {
          await oss.abortMultipartUpload(ossKey, uploadId);
        } catch (abortErr) {
          logger.warn({ err: abortErr, ossKey }, 'upload_initiate_compensation_failed');
        }
        throw err;
      }

      logger.info(
        {
          attachmentId: attachment.id,
          ownerId: req.user.id,
          kind: body.data.kind,
          partCount: body.data.part_count,
          sizeBytes: body.data.size_bytes,
        },
        'upload_initiated',
      );

      res.status(201).json({
        attachment_id: attachment.id,
        upload_id: uploadId,
        part_urls: partUrls,
      });
    }),
  );

  router.post(
    '/:attachmentId/complete',
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const params = AttachmentIdParamSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }
      const body = CompleteBodySchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      const attachment = await findOwnedAttachment(db, params.data.attachmentId, req.user.id);
      if (!attachment) {
        res.status(404).json({ error: 'ATTACHMENT_NOT_FOUND' });
        return;
      }
      if (attachment.status !== 'uploading' || attachment.oss_upload_id === null) {
        res.status(409).json({ error: 'UPLOAD_INVALID_STATE', status: attachment.status });
        return;
      }
      const expectedPartNumbers = new Set(
        Array.from({ length: attachment.part_count }, (_unused, index) => index + 1),
      );
      if (
        body.data.parts.length !== attachment.part_count ||
        body.data.parts.some((part) => !expectedPartNumbers.has(part.part_number))
      ) {
        res.status(400).json({ error: 'UPLOAD_INVALID_PARTS' });
        return;
      }

      // Atomic claim BEFORE touching OSS: a concurrent complete/abort loser
      // must see 409 here and never reach completeMultipartUpload (review P1).
      const claimed = await transitionAttachmentStatus(
        db,
        attachment.id,
        'uploading',
        'completing',
      );
      if (!claimed) {
        res.status(409).json({ error: 'UPLOAD_INVALID_STATE' });
        return;
      }

      try {
        await oss.completeMultipartUpload(
          attachment.oss_key,
          attachment.oss_upload_id,
          body.data.parts,
          Number(attachment.size_bytes),
        );
      } catch (err) {
        logger.warn(
          { err, attachmentId: attachment.id, ownerId: req.user.id },
          'upload_complete_oss_failed',
        );
        await transitionAttachmentStatus(db, attachment.id, 'completing', 'uploading');
        res.status(400).json({ error: 'UPLOAD_INVALID_PARTS' });
        return;
      }

      let actualSizeBytes: number;
      try {
        const object = await verifyCompletedObject(attachment);
        if (object === null) {
          await failSizeVerification(attachment, null);
          res.status(409).json({ error: 'UPLOAD_SIZE_MISMATCH' });
          return;
        }
        actualSizeBytes = object.sizeBytes;
      } catch (err) {
        logger.warn({ err, attachmentId: attachment.id }, 'upload_size_verification_failed');
        await transitionAttachmentStatus(db, attachment.id, 'completing', 'uploading');
        res.status(502).json({ error: 'UPLOAD_SIZE_VERIFICATION_FAILED' });
        return;
      }
      if (actualSizeBytes !== Number(attachment.size_bytes)) {
        await failSizeVerification(attachment, actualSizeBytes);
        res.status(409).json({ error: 'UPLOAD_SIZE_MISMATCH' });
        return;
      }

      const updated = await markAttachmentReady(db, attachment.id, actualSizeBytes);
      if (!updated) {
        // completing -> ready can only be raced by operators poking the DB.
        res.status(409).json({ error: 'UPLOAD_INVALID_STATE' });
        return;
      }

      logger.info({ attachmentId: updated.id, ownerId: req.user.id }, 'upload_completed');
      res.status(200).json(serializeAttachment(updated));
    }),
  );

  router.post(
    '/:attachmentId/abort',
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const params = AttachmentIdParamSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }
      const abortBody = AbortBodySchema.safeParse(req.body ?? {});
      if (!abortBody.success) {
        res.status(400).json(validationEnvelope(abortBody.error));
        return;
      }

      const attachment = await findOwnedAttachment(db, params.data.attachmentId, req.user.id);
      if (!attachment) {
        res.status(404).json({ error: 'ATTACHMENT_NOT_FOUND' });
        return;
      }
      if (attachment.status === 'aborted') {
        // Idempotent re-abort.
        res.status(204).send();
        return;
      }
      if (attachment.status !== 'uploading' || attachment.oss_upload_id === null) {
        res.status(409).json({ error: 'UPLOAD_INVALID_STATE', status: attachment.status });
        return;
      }

      // Atomic claim BEFORE touching OSS, mirroring complete: a stale abort
      // that lost to a concurrent complete-claim must never abort the OSS
      // upload out from under it (Codex second-pass P1).
      const claimed = await transitionAttachmentStatus(db, attachment.id, 'uploading', 'aborting');
      if (!claimed) {
        const current = await findOwnedAttachment(db, attachment.id, req.user.id);
        if (current?.status === 'aborted') {
          res.status(204).send();
          return;
        }
        res.status(409).json({ error: 'UPLOAD_INVALID_STATE' });
        return;
      }

      try {
        // Service swallows NoSuchUpload (already expired/cleaned on OSS side).
        await oss.abortMultipartUpload(attachment.oss_key, attachment.oss_upload_id);
      } catch (err) {
        logger.warn(
          { err, attachmentId: attachment.id, ownerId: req.user.id },
          'upload_abort_oss_failed',
        );
        await transitionAttachmentStatus(db, attachment.id, 'aborting', 'uploading');
        res.status(502).json({ error: 'UPLOAD_ABORT_FAILED' });
        return;
      }

      await transitionAttachmentStatus(db, attachment.id, 'aborting', 'aborted');
      logger.info({ attachmentId: attachment.id, ownerId: req.user.id }, 'upload_aborted');
      res.status(204).send();
    }),
  );

  router.post(
    '/:attachmentId/reconcile',
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }
      const params = AttachmentIdParamSchema.safeParse(req.params);
      const body = AbortBodySchema.safeParse(req.body ?? {});
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }
      const attachment = await findOwnedAttachment(db, params.data.attachmentId, req.user.id);
      if (!attachment) {
        res.status(404).json({ error: 'ATTACHMENT_NOT_FOUND' });
        return;
      }

      if (attachment.status === 'completing') {
        try {
          const object = await oss.headObject(attachment.oss_key);
          if (object?.sizeBytes === Number(attachment.size_bytes)) {
            const ready = await markAttachmentReady(db, attachment.id, object.sizeBytes);
            res.status(200).json(serializeAttachment(ready ?? attachment));
            return;
          }
          if (object !== null) await failSizeVerification(attachment, object.sizeBytes);
          else await transitionAttachmentStatus(db, attachment.id, 'completing', 'uploading');
        } catch (err) {
          logger.warn({ err, attachmentId: attachment.id }, 'upload_reconcile_complete_failed');
          res.status(502).json({ error: 'UPLOAD_RECONCILE_FAILED' });
          return;
        }
      } else if (attachment.status === 'aborting' && attachment.oss_upload_id !== null) {
        try {
          await oss.abortMultipartUpload(attachment.oss_key, attachment.oss_upload_id);
          await transitionAttachmentStatus(db, attachment.id, 'aborting', 'aborted');
        } catch (err) {
          logger.warn({ err, attachmentId: attachment.id }, 'upload_reconcile_abort_failed');
          res.status(502).json({ error: 'UPLOAD_RECONCILE_FAILED' });
          return;
        }
      } else if (attachment.status === 'deleting') {
        const deletion = await lockAttachmentForDeletion(attachment.id, req.user.id, false);
        if (deletion.outcome === 'not_found') {
          res.status(404).json({ error: 'ATTACHMENT_NOT_FOUND' });
          return;
        }
        if (deletion.outcome === 'in_use') {
          res.status(409).json({ error: 'ATTACHMENT_IN_USE' });
          return;
        }
        if (deletion.outcome === 'invalid_state') {
          res.status(409).json({
            error: 'UPLOAD_INVALID_STATE',
            status: deletion.attachment.status,
          });
          return;
        }

        // Recheck after the deleting claim and before OSS. PostgreSQL's shared
        // attachment row lock makes this redundant in production, but it closes
        // the same safe send-wins branch in lockless test adapters. New sends
        // revalidate status in their INSERT and cannot start once claimed.
        if (await attachmentIsReferenced(deletion.attachment.id)) {
          res.status(409).json({ error: 'ATTACHMENT_IN_USE' });
          return;
        }

        try {
          // The locking transaction has committed before this network call.
          await deleteRemoteAttachment(deletion.attachment);
          await deleteAttachmentMetadata(db, deletion.attachment.id, req.user.id);
          res.status(204).send();
          return;
        } catch (err) {
          logger.warn({ err, attachmentId: attachment.id }, 'upload_reconcile_delete_failed');
          res.status(502).json({ error: 'UPLOAD_RECONCILE_FAILED' });
          return;
        }
      }

      const current = await findOwnedAttachment(db, attachment.id, req.user.id);
      res.status(200).json(serializeAttachment(current ?? attachment));
    }),
  );

  router.delete(
    '/:attachmentId',
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }
      const params = AttachmentIdParamSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }

      const deletion = await lockAttachmentForDeletion(params.data.attachmentId, req.user.id, true);
      if (deletion.outcome === 'not_found') {
        res.status(404).json({ error: 'ATTACHMENT_NOT_FOUND' });
        return;
      }
      if (deletion.outcome === 'in_use') {
        res.status(409).json({ error: 'ATTACHMENT_IN_USE' });
        return;
      }
      if (deletion.outcome === 'invalid_state') {
        res.status(409).json({
          error: 'UPLOAD_INVALID_STATE',
          status: deletion.attachment.status,
        });
        return;
      }

      // A send that read `ready` before this transaction claimed `deleting`
      // may have committed its FK in a lockless adapter. Resolve that race before
      // any OSS side effect, then restore the pre-claim state for the live message.
      if (await attachmentIsReferenced(deletion.attachment.id)) {
        await releaseDeletionClaim(deletion.attachment.id, deletion.previousStatus);
        res.status(409).json({ error: 'ATTACHMENT_IN_USE' });
        return;
      }

      try {
        // The locking/claim transaction has committed before this network call.
        await deleteRemoteAttachment(deletion.attachment);
      } catch (err) {
        logger.warn(
          { err, attachmentId: deletion.attachment.id, ownerId: req.user.id },
          'upload_delete_oss_failed',
        );
        await transitionAttachmentStatus(
          db,
          deletion.attachment.id,
          'deleting',
          deletion.previousStatus,
        );
        res.status(502).json({ error: 'UPLOAD_DELETE_FAILED' });
        return;
      }

      const deleted = await deleteAttachmentMetadata(db, deletion.attachment.id, req.user.id);
      if (!deleted) {
        // The remote object is already gone. Leave the durable deleting state so
        // a retry of POST /reconcile can finish local cleanup safely.
        res.status(409).json({ error: 'UPLOAD_INVALID_STATE' });
        return;
      }

      logger.info({ attachmentId: deletion.attachment.id, ownerId: req.user.id }, 'upload_deleted');
      res.status(204).send();
    }),
  );

  router.get(
    '/:attachmentId/url',
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const params = AttachmentIdParamSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }

      const attachment = await findAttachment(db, params.data.attachmentId);
      if (!attachment) {
        res.status(404).json({ error: 'ATTACHMENT_NOT_FOUND' });
        return;
      }

      if (!uuidEquals(attachment.owner_id, req.user.id)) {
        if (attachment.kind === 'chat_image') {
          res.status(404).json({ error: 'ATTACHMENT_NOT_FOUND' });
          return;
        }
        // Only the owner's accepted-bind coach may read; everyone else gets the
        // same 404 as a missing row so attachment existence never leaks.
        const bound = await coachHasAcceptedBind(db, req.user.id, attachment.owner_id);
        if (!bound) {
          res.status(404).json({ error: 'ATTACHMENT_NOT_FOUND' });
          return;
        }
        // A linked video is scoped by immutable provenance, not a mutable join
        // through set_logs. Only explicitly-created unlinked uploads can be
        // shared with any accepted coach; legacy/unproven orphans stay private.
        const isExplicitlyUnlinked =
          attachment.is_unlinked_explicit && attachment.source_coach_id === null;
        if (!isExplicitlyUnlinked && !uuidEquals(attachment.source_coach_id, req.user.id)) {
          res.status(404).json({ error: 'ATTACHMENT_NOT_FOUND' });
          return;
        }
      }

      if (attachment.status !== 'ready') {
        res.status(409).json({ error: 'ATTACHMENT_NOT_READY', status: attachment.status });
        return;
      }

      const url = await oss.signGetUrl(attachment.oss_key, GET_URL_TTL_SECONDS);
      res.status(200).json({ url, expires_in: GET_URL_TTL_SECONDS });
    }),
  );

  return router;
}
