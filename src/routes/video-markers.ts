import { Router, type Router as ExpressRouter } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import { VIDEO_MARKER_LEVELS, type Database, type VideoMarkerLevel } from '../db/types';
import { timestamp } from '../handlers/serialization';
import { resolveSetVideoAccess } from '../handlers/set-video-access';
import { requireRole } from '../middleware/auth';
import { uuidEquals } from '../utils/uuid';
import { route, validationEnvelope } from './http';

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const NOTE_MAX_LENGTH = 500;

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
  })
  .strict()
  .transform((body) => ({
    time_ms: body.time_ms,
    level: body.level ?? 'info',
    note: body.note ?? '',
  }));

interface VideoMarkersRouterDeps {
  db: Kysely<Database>;
}

function serializeMarker(marker: {
  id: string;
  video_id: string;
  coach_id: string;
  time_ms: number;
  level: VideoMarkerLevel;
  note: string;
  created_at: Date;
}) {
  return {
    id: marker.id,
    video_id: marker.video_id,
    coach_id: marker.coach_id,
    time_ms: marker.time_ms,
    level: marker.level,
    note: marker.note,
    created_at: timestamp(marker.created_at),
  };
}

export function videoMarkersRouter(deps: VideoMarkersRouterDeps): ExpressRouter {
  const router = Router();
  const { db } = deps;

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

      const rows = await db
        .selectFrom('video_markers')
        .selectAll()
        .where('video_id', '=', access.video.id)
        .orderBy('time_ms', 'asc')
        .orderBy('created_at', 'asc')
        .orderBy('id', 'asc')
        .execute();

      res.status(200).json({ markers: rows.map(serializeMarker) });
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

      const marker = await db
        .insertInto('video_markers')
        .values({
          video_id: access.video.id,
          coach_id: req.user.id,
          time_ms: body.data.time_ms,
          level: body.data.level,
          note: body.data.note,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      res.status(201).json(serializeMarker(marker));
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
