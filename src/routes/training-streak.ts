import { Router, type Router as ExpressRouter } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { Database } from '../db/types';
import { getStudentTrainingStreak } from '../handlers/training-streak';
import { requireRole } from '../middleware/auth';
import { isIsoCalendarDate, isoCalendarDateSchemaMessage, trainingDay } from '../utils/date';
import { route, validationEnvelope } from './http';

const DateSchema = z
  .string()
  .refine(isIsoCalendarDate, { message: isoCalendarDateSchemaMessage() });
const StreakQuerySchema = z
  .object({
    as_of: DateSchema.optional(),
  })
  .strict();

export function studentTrainingStreakRouter(deps: { db: Kysely<Database> }): ExpressRouter {
  const router = Router();

  router.get(
    '/me/streak',
    requireRole('coached_student', 'self_train_student'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const query = StreakQuerySchema.safeParse(req.query);
      if (!query.success) {
        res.status(400).json(validationEnvelope(query.error));
        return;
      }

      const student = await deps.db
        .selectFrom('users')
        .select('timezone')
        .where('id', '=', req.user.id)
        .executeTakeFirst();
      if (!student) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }
      // training_sessions.session_date uses the student's 04:00 gym-day.
      const asOf = query.data.as_of ?? trainingDay(new Date(), student.timezone);
      const streak = await getStudentTrainingStreak(deps.db, req.user.id, asOf);

      res.status(200).json({
        streak: {
          current: streak.current,
          as_of: asOf,
          started_on: streak.startedOn,
          last_session_date: streak.lastSessionDate,
        },
      });
    }),
  );

  return router;
}
