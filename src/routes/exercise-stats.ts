import { Router, type Router as ExpressRouter } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import { hasAcceptedBond } from '../db/bonds';
import type { Database } from '../db/types';
import { fetchExerciseStatsDetail, fetchExerciseStatsOverview } from '../handlers/exercise-stats';
import { requireRole } from '../middleware/auth';
import { route, validationEnvelope } from './http';

const ParamsSchema = z.object({ id: z.string().uuid() });
const QuerySchema = z.object({ exercise_id: z.string().uuid().optional() }).strict();
const PositiveIntegerQuerySchema = z.string().regex(/^\d+$/).transform(Number);
const DetailQuerySchema = QuerySchema.extend({
  sets: PositiveIntegerQuerySchema.pipe(z.number().int().min(1).max(20)).optional(),
  reps: PositiveIntegerQuerySchema.pipe(z.number().int().min(1).max(50)).optional(),
});

interface ExerciseStatsRouterDeps {
  db: Kysely<Database>;
}

export function coachExerciseStatsRouter(deps: ExerciseStatsRouterDeps): ExpressRouter {
  const router = Router();
  router.get(
    '/students/:id/exercise-stats',
    requireRole('coach'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }
      const params = ParamsSchema.safeParse(req.params);
      const query: z.SafeParseReturnType<unknown, z.infer<typeof DetailQuerySchema>> = req.query
        .exercise_id === undefined
        ? QuerySchema.safeParse(req.query)
        : DetailQuerySchema.safeParse(req.query);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }
      if (!query.success) {
        res.status(400).json(validationEnvelope(query.error));
        return;
      }
      if (!(await hasAcceptedBond(deps.db, req.user.id, params.data.id))) {
        res.status(403).json({ error: 'AUTHORIZATION_FORBIDDEN' });
        return;
      }

      const response = query.data.exercise_id
        ? await fetchExerciseStatsDetail(
            deps.db,
            req.user.id,
            params.data.id,
            query.data.exercise_id,
            query.data.sets !== undefined
              ? { sets: query.data.sets, reps: query.data.reps }
              : undefined,
          )
        : await fetchExerciseStatsOverview(deps.db, req.user.id, params.data.id, req.locale);
      res.status(200).json(response);
    }),
  );
  return router;
}
