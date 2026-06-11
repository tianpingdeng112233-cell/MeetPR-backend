import { randomUUID } from 'node:crypto';

import { Router, type Router as ExpressRouter } from 'express';
import type { Kysely } from 'kysely';

import type { Database } from '../../db/types';
import {
  coachHasAcceptedBind,
  findAttachment,
  findOwnedAttachment,
  insertAttachment,
  serializeAttachment,
  transitionAttachmentStatus,
} from '../../handlers/attachments';
import type { Logger } from '../../logger';
import type { OssService } from '../../services/oss';
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

      const extension = CONTENT_TYPE_EXTENSIONS[body.data.content_type];
      if (extension === undefined) {
        // Unreachable while the whitelist and extension map stay in sync.
        res.status(400).json({ error: 'UPLOAD_CONTENT_TYPE_MISMATCH' });
        return;
      }

      // Real gate: a set_video may only link to the uploader's own set log.
      if (body.data.set_log_id !== undefined) {
        const ownedLog = await db
          .selectFrom('set_logs')
          .select(['id'])
          .where('id', '=', body.data.set_log_id)
          .where('student_id', '=', req.user.id)
          .executeTakeFirst();
        if (!ownedLog) {
          res.status(404).json({ error: 'SET_LOG_NOT_FOUND' });
          return;
        }
      }

      const ossKey = `attachments/${req.user.id}/${randomUUID()}${extension}`;
      const uploadId = await oss.initiateMultipartUpload(ossKey, body.data.content_type);

      const attachment = await insertAttachment(db, {
        owner_id: req.user.id,
        kind: body.data.kind,
        oss_key: ossKey,
        oss_upload_id: uploadId,
        content_type: body.data.content_type,
        size_bytes: body.data.size_bytes,
        filename: body.data.filename ?? null,
        set_log_id: body.data.set_log_id ?? null,
      });

      const partUrls = await oss.signPartUrls(
        ossKey,
        uploadId,
        body.data.part_count,
        PART_URL_TTL_SECONDS,
      );

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

      const updated = await transitionAttachmentStatus(db, attachment.id, 'completing', 'ready');
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

      if (attachment.owner_id !== req.user.id) {
        // Only the owner's accepted-bind coach may read; everyone else gets the
        // same 404 as a missing row so attachment existence never leaks.
        const bound = await coachHasAcceptedBind(db, req.user.id, attachment.owner_id);
        if (!bound) {
          res.status(404).json({ error: 'ATTACHMENT_NOT_FOUND' });
          return;
        }
        // Wall-scoping parity (spec 007): a linked video belongs to the plan's
        // coach; another bonded coach must not bypass the wall filter by
        // exchanging a known attachment id directly.
        if (attachment.set_log_id !== null) {
          const owned = await db
            .selectFrom('set_logs as sl')
            .innerJoin('plan_exercises as pe', 'pe.id', 'sl.plan_exercise_id')
            .innerJoin('plan_days as pd', 'pd.id', 'pe.plan_day_id')
            .innerJoin('plans as p', 'p.id', 'pd.plan_id')
            .select(['sl.id'])
            .where('sl.id', '=', attachment.set_log_id)
            .where('p.coach_id', '=', req.user.id)
            .executeTakeFirst();
          if (!owned) {
            res.status(404).json({ error: 'ATTACHMENT_NOT_FOUND' });
            return;
          }
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
