import { Router, type Router as ExpressRouter } from 'express';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import { VIDEO_MARKER_LEVELS, type Database, type VideoMarkerLevel } from '../db/types';
import { requesterOssSignOptions } from '../handlers/oss-sign-options';
import { timestamp } from '../handlers/serialization';
import { resolveSetVideoAccess } from '../handlers/set-video-access';
import { requireRole } from '../middleware/auth';
import type { OssService, OssSignOptions } from '../services/oss';
import { uuidEquals } from '../utils/uuid';
import { route, validationEnvelope } from './http';

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const NOTE_MAX_LENGTH = 500;
const ANNOTATION_URL_TTL_SECONDS = 900; // Same 15min invariant as video playback URLs.

const VideoParamsSchema = z.object({
  videoId: z.string().uuid(),
});

const MarkerParamsSchema = z.object({
  videoId: z.string().uuid(),
  markerId: z.string().uuid(),
});

const CreateMarkerBodySchema = z
  .object({
    time_ms: z.number().int().min(0).max(POSTGRES_INTEGER_MAX),
    level: z.enum(VIDEO_MARKER_LEVELS).optional(),
    note: z.string().max(NOTE_MAX_LENGTH).optional(),
    attachment_id: z.string().uuid().optional(),
  })
  .strict()
  .transform((body) => ({
    time_ms: body.time_ms,
    level: body.level ?? 'info',
    note: body.note ?? '',
    attachment_id: body.attachment_id ?? null,
  }));

interface VideoMarkersRouterDeps {
  db: Kysely<Database>;
  oss?: OssService | undefined;
  logger?: { warn: (obj: unknown, msg: string) => void } | undefined;
}

async function serializeMarker(
  marker: {
    id: string;
    video_id: string;
    coach_id: string;
    attachment_id: string | null;
    time_ms: number;
    level: VideoMarkerLevel;
    note: string;
    created_at: Date;
  },
  annotationOssKey: string | null,
  oss: OssService | undefined,
  signOptions: OssSignOptions,
  logger?: { warn: (obj: unknown, msg: string) => void },
) {
  // Signing must never take down the whole list (or fail a POST whose row is
  // already committed): degrade this one marker to a plain one instead.
  let annotationUrl: string | null = null;
  if (marker.attachment_id !== null && annotationOssKey !== null && oss) {
    try {
      annotationUrl = await oss.signGetUrl(
        annotationOssKey,
        ANNOTATION_URL_TTL_SECONDS,
        signOptions,
      );
    } catch (err) {
      logger?.warn({ err, markerId: marker.id }, 'marker_annotation_sign_failed');
      annotationUrl = null;
    }
  }

  return {
    id: marker.id,
    video_id: marker.video_id,
    coach_id: marker.coach_id,
    attachment_id: marker.attachment_id,
    annotation_url: annotationUrl,
    annotation_expires_in: annotationUrl === null ? null : ANNOTATION_URL_TTL_SECONDS,
    time_ms: marker.time_ms,
    level: marker.level,
    note: marker.note,
    created_at: timestamp(marker.created_at),
  };
}

export function videoMarkersRouter(deps: VideoMarkersRouterDeps): ExpressRouter {
  const router = Router();
  const { db, oss, logger } = deps;

  router.get(
    '/:videoId/markers',
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const params = VideoParamsSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }

      const access = await resolveSetVideoAccess(db, req.user, params.data.videoId);
      if (access.outcome === 'not_found') {
        res.status(404).json({ error: 'ATTACHMENT_NOT_FOUND' });
        return;
      }
      if (access.outcome === 'forbidden') {
        res.status(403).json({ error: 'AUTHORIZATION_FORBIDDEN' });
        return;
      }
      if (access.video.status !== 'ready') {
        res.status(409).json({ error: 'ATTACHMENT_NOT_READY', status: access.video.status });
        return;
      }

      const signOptions = await requesterOssSignOptions(db, oss, req.user.id, logger);
      if (signOptions === null) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const rows = await db
        .selectFrom('video_markers')
        .leftJoin('attachments as annotation', 'annotation.id', 'video_markers.attachment_id')
        .selectAll('video_markers')
        .select([
          'annotation.oss_key as annotation_oss_key',
          'annotation.status as annotation_status',
        ])
        .where('video_markers.video_id', '=', access.video.id)
        .orderBy('video_markers.time_ms', 'asc')
        .orderBy('video_markers.created_at', 'asc')
        .orderBy('video_markers.id', 'asc')
        .execute();

      const markers = await Promise.all(
        rows.map((row) =>
          serializeMarker(
            row,
            row.annotation_status === 'ready' ? row.annotation_oss_key : null,
            oss,
            signOptions,
            logger,
          ),
        ),
      );
      res.status(200).json({ markers });
    }),
  );

  router.post(
    '/:videoId/viewed',
    requireRole('coach'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const params = VideoParamsSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }

      const access = await resolveSetVideoAccess(db, req.user, params.data.videoId);
      if (access.outcome === 'not_found') {
        res.status(404).json({ error: 'ATTACHMENT_NOT_FOUND' });
        return;
      }
      if (access.outcome === 'forbidden' || access.relation !== 'bonded_coach') {
        res.status(403).json({ error: 'AUTHORIZATION_FORBIDDEN' });
        return;
      }
      if (access.video.status !== 'ready') {
        res.status(409).json({ error: 'ATTACHMENT_NOT_READY', status: access.video.status });
        return;
      }

      const updated = await db
        .updateTable('attachments')
        .set({ coach_viewed_at: sql<Date>`now()` })
        .where('id', '=', access.video.id)
        .where('coach_viewed_at', 'is', null)
        .returning('coach_viewed_at')
        .executeTakeFirst();
      const current =
        updated ??
        (await db
          .selectFrom('attachments')
          .select('coach_viewed_at')
          .where('id', '=', access.video.id)
          .executeTakeFirstOrThrow());
      if (current.coach_viewed_at === null) {
        throw new Error('coach_viewed_at missing after viewed update');
      }

      res.status(200).json({ viewed_at: timestamp(current.coach_viewed_at) });
    }),
  );

  router.post(
    '/:videoId/markers',
    requireRole('coach'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const params = VideoParamsSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }

      const body = CreateMarkerBodySchema.safeParse(req.body);
      if (!body.success) {
        res.status(422).json(validationEnvelope(body.error));
        return;
      }

      const access = await resolveSetVideoAccess(db, req.user, params.data.videoId);
      if (access.outcome === 'not_found') {
        res.status(404).json({ error: 'ATTACHMENT_NOT_FOUND' });
        return;
      }
      if (access.outcome === 'forbidden' || access.relation !== 'bonded_coach') {
        res.status(403).json({ error: 'AUTHORIZATION_FORBIDDEN' });
        return;
      }
      if (access.video.status !== 'ready') {
        res.status(409).json({ error: 'ATTACHMENT_NOT_READY', status: access.video.status });
        return;
      }
      const user = req.user;
      const signOptions = await requesterOssSignOptions(db, oss, user.id, logger);
      if (signOptions === null) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const result = await db.transaction().execute(async (trx) => {
        let annotationOssKey: string | null = null;
        if (body.data.attachment_id !== null) {
          const annotation = await trx
            .selectFrom('attachments')
            .select(['id', 'owner_id', 'kind', 'status', 'oss_key'])
            .where('id', '=', body.data.attachment_id)
            .forUpdate()
            .executeTakeFirst();
          if (
            !annotation ||
            !uuidEquals(annotation.owner_id, user.id) ||
            annotation.kind !== 'chat_image'
          ) {
            return { outcome: 'not_found' as const };
          }
          if (annotation.status !== 'ready') {
            return { outcome: 'not_ready' as const, status: annotation.status };
          }
          // Cross-student wall: the image must already have been sent into
          // the conversation between this coach and THIS video's owner. A
          // coach's image from another student's thread (or a never-sent
          // orphan) must not become visible to this student via the marker.
          const provenance = await trx
            .selectFrom('messages as m')
            .innerJoin('conversations as c', 'c.id', 'm.conversation_id')
            .select('m.id')
            .where('m.attachment_id', '=', annotation.id)
            .where('c.coach_id', '=', user.id)
            .where('c.student_id', '=', access.video.owner_id)
            .limit(1)
            .executeTakeFirst();
          if (!provenance) {
            return { outcome: 'not_found' as const };
          }
          annotationOssKey = annotation.oss_key;
        }

        const marker = await trx
          .insertInto('video_markers')
          .values({
            video_id: access.video.id,
            coach_id: user.id,
            attachment_id: body.data.attachment_id,
            time_ms: body.data.time_ms,
            level: body.data.level,
            note: body.data.note,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        return { outcome: 'created' as const, marker, annotationOssKey };
      });

      if (result.outcome === 'not_found') {
        res.status(404).json({ error: 'ATTACHMENT_NOT_FOUND' });
        return;
      }
      if (result.outcome === 'not_ready') {
        res.status(409).json({ error: 'ATTACHMENT_NOT_READY', status: result.status });
        return;
      }

      res
        .status(201)
        .json(
          await serializeMarker(result.marker, result.annotationOssKey, oss, signOptions, logger),
        );
    }),
  );

  router.delete(
    '/:videoId/markers/:markerId',
    requireRole('coach'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const params = MarkerParamsSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }

      const access = await resolveSetVideoAccess(db, req.user, params.data.videoId);
      if (access.outcome === 'not_found') {
        res.status(404).json({ error: 'ATTACHMENT_NOT_FOUND' });
        return;
      }
      if (access.outcome === 'forbidden' || access.relation !== 'bonded_coach') {
        res.status(403).json({ error: 'AUTHORIZATION_FORBIDDEN' });
        return;
      }
      if (access.video.status !== 'ready') {
        res.status(409).json({ error: 'ATTACHMENT_NOT_READY', status: access.video.status });
        return;
      }

      const marker = await db
        .selectFrom('video_markers')
        .select(['id', 'coach_id'])
        .where('id', '=', params.data.markerId)
        .where('video_id', '=', access.video.id)
        .executeTakeFirst();
      if (!marker) {
        res.status(404).json({ error: 'VIDEO_MARKER_NOT_FOUND' });
        return;
      }

      if (!uuidEquals(marker.coach_id, req.user.id)) {
        res.status(403).json({ error: 'AUTHORIZATION_FORBIDDEN' });
        return;
      }

      await db.deleteFrom('video_markers').where('id', '=', marker.id).execute();
      res.status(204).send();
    }),
  );

  return router;
}
