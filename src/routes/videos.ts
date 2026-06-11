import { Router, type Router as ExpressRouter } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import { hasAcceptedBond } from '../db/bonds';
import type { Database } from '../db/types';
import type { OssService } from '../services/oss';
import { timestamp } from '../handlers/serialization';
import { route, validationEnvelope } from './http';

const GET_URL_TTL_SECONDS = 900; // 15min invariant, same as GET /uploads/:id/url.
const WALL_LIMIT = 100; // Newest-first cap; paging is a post-V0.1 concern.

const ParamsSchema = z.object({ id: z.string().uuid() });

interface StudentVideosRouterDeps {
  db: Kysely<Database>;
  /** Absent when OSS env vars are not configured — route answers 503. */
  oss?: OssService | undefined;
}

/**
 * GET /students/:id/videos — the coach-side video wall source (spec 007).
 * Ready set videos with their set_log linkage and a short-lived playback URL
 * per item. Authorization mirrors GET /students/:id/sets: student self or an
 * accepted-bind coach.
 */
export function studentVideosRouter(deps: StudentVideosRouterDeps): ExpressRouter {
  const router = Router();
  const { db, oss } = deps;

  router.get(
    '/:id/videos',
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }
      if (!oss) {
        res.status(503).json({ error: 'UPLOADS_NOT_CONFIGURED' });
        return;
      }

      const params = ParamsSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }
      const studentId = params.data.id;

      const isSelf = req.user.id === studentId;
      if (!isSelf) {
        const bonded =
          req.user.role === 'coach' && (await hasAcceptedBond(db, req.user.id, studentId));
        if (!bonded) {
          res.status(403).json({ error: 'AUTHORIZATION_FORBIDDEN' });
          return;
        }
      }

      const rows = await db
        .selectFrom('attachments as a')
        .leftJoin('set_logs as sl', 'sl.id', 'a.set_log_id')
        .select([
          'a.id as id',
          'a.set_log_id as set_log_id',
          'a.content_type as content_type',
          'a.size_bytes as size_bytes',
          'a.filename as filename',
          'a.created_at as created_at',
          'sl.logged_at as logged_at',
          'sl.plan_exercise_id as plan_exercise_id',
          'a.oss_key as oss_key',
        ])
        .where('a.owner_id', '=', studentId)
        .where('a.kind', '=', 'set_video')
        .where('a.status', '=', 'ready')
        .orderBy('a.created_at', 'desc')
        .limit(WALL_LIMIT)
        .execute();

      const videos = await Promise.all(
        rows.map(async (row) => ({
          id: row.id,
          set_log_id: row.set_log_id,
          plan_exercise_id: row.plan_exercise_id,
          content_type: row.content_type,
          size_bytes: Number(row.size_bytes),
          filename: row.filename,
          created_at: timestamp(row.created_at),
          logged_at: row.logged_at === null ? null : timestamp(row.logged_at),
          url: await oss.signGetUrl(row.oss_key, GET_URL_TTL_SECONDS),
          url_expires_in: GET_URL_TTL_SECONDS,
        })),
      );

      res.status(200).json({ videos });
    }),
  );

  return router;
}
