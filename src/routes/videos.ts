import { Router, type Router as ExpressRouter } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import { hasAcceptedBond } from '../db/bonds';
import type { Database } from '../db/types';
import { timestamp } from '../handlers/serialization';
import { uuidEquals } from '../utils/uuid';
import { route, validationEnvelope } from './http';

const WALL_LIMIT = 100; // Newest-first cap; paging is a post-V0.1 concern.

const ParamsSchema = z.object({ id: z.string().uuid() });

interface StudentVideosRouterDeps {
  db: Kysely<Database>;
}

/**
 * GET /students/:id/videos — the coach-side video wall source (spec 007).
 * Metadata only: playback goes through GET /uploads/:id/url per item, so a
 * single intercepted response never leaks a wall of live URLs (Codex review).
 * Authorization mirrors GET /students/:id/sets — student self, or an
 * accepted-bind coach scoped by immutable upload provenance (dual-coach
 * students don't leak across coaches). Only uploads explicitly created without
 * a set-log link are shareable with any bonded coach; legacy/orphaned links are
 * deliberately not treated as unlinked.
 */
export function studentVideosRouter(deps: StudentVideosRouterDeps): ExpressRouter {
  const router = Router();
  const { db } = deps;

  router.get(
    '/:id/videos',
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const params = ParamsSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }
      const studentId = params.data.id;

      const isSelf = uuidEquals(req.user.id, studentId);
      const isBondedCoach =
        !isSelf && req.user.role === 'coach' && (await hasAcceptedBond(db, req.user.id, studentId));
      if (!isSelf && !isBondedCoach) {
        res.status(403).json({ error: 'AUTHORIZATION_FORBIDDEN' });
        return;
      }

      let query = db
        .selectFrom('attachments as a')
        .leftJoin('set_logs as sl', 'sl.id', 'a.set_log_id')
        .leftJoin('exercises as e', 'e.id', 'sl.exercise_id')
        .leftJoin('plan_exercises as pe', 'pe.id', 'sl.plan_exercise_id')
        .leftJoin('plan_days as pd', 'pd.id', 'pe.plan_day_id')
        .leftJoin('plans as p', 'p.id', 'pd.plan_id')
        .select([
          'a.id as id',
          'a.set_log_id as set_log_id',
          'sl.plan_exercise_id as plan_exercise_id',
          'e.name as exercise_name',
          'sl.set_index as set_index',
          'sl.weight_kg as weight_kg',
          'sl.reps as reps',
          'a.content_type as content_type',
          'a.size_bytes as size_bytes',
          'a.filename as filename',
          'a.created_at as created_at',
          'sl.logged_at as logged_at',
        ])
        .where('a.owner_id', '=', studentId)
        .where('a.kind', '=', 'set_video')
        .where('a.status', '=', 'ready');

      if (isBondedCoach) {
        // A set-log can be detached by legacy data maintenance. Its immutable
        // source coach remains the visibility gate, so an orphan cannot become
        // a broadly-visible "unlinked" video.
        const coachId = req.user.id;
        query = query.where((eb) =>
          eb.or([
            eb.and([eb('a.is_unlinked_explicit', '=', true), eb('a.source_coach_id', 'is', null)]),
            eb('a.source_coach_id', '=', coachId),
          ]),
        );
      }

      const rows = await query.orderBy('a.created_at', 'desc').limit(WALL_LIMIT).execute();

      const videos = rows.map((row) => ({
        id: row.id,
        set_log_id: row.set_log_id,
        plan_exercise_id: row.plan_exercise_id,
        exercise_name: row.exercise_name,
        set_index: row.set_index,
        weight_kg: row.weight_kg === null ? null : Number(row.weight_kg).toFixed(2),
        reps: row.reps,
        content_type: row.content_type,
        size_bytes: Number(row.size_bytes),
        filename: row.filename,
        created_at: timestamp(row.created_at),
        logged_at: row.logged_at === null ? null : timestamp(row.logged_at),
      }));

      res.status(200).json({ videos });
    }),
  );

  return router;
}
