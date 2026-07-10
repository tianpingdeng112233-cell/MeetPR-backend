import { Router, type Router as ExpressRouter } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { Database } from '../db/types';
import { fetchCoachFeedback, fetchOwnFeedback } from '../handlers/feedback-fetch';
import { markFeedbackRead } from '../handlers/feedback-mark-read';
import {
  coachHasPublishedPlanForStudent,
  coachOwnsPublishedPlanExercise,
  createFeedback,
} from '../handlers/feedback-post';
import { requireRole } from '../middleware/auth';
import { isIsoCalendarDate, isoCalendarDateSchemaMessage } from '../utils/date';
import { uuidEquals } from '../utils/uuid';
import { route, validationEnvelope } from './http';

interface FeedbackRouterDeps {
  db: Kysely<Database>;
}

const UuidSchema = z.string().uuid();
const DateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
  .refine(isIsoCalendarDate, isoCalendarDateSchemaMessage());

const FeedbackBodySchema = z
  .object({
    student_id: UuidSchema,
    day_date: DateSchema.nullable().optional(),
    plan_exercise_id: UuidSchema.nullable().optional(),
    text: z.string().trim().min(1).max(2000),
  })
  .strict()
  .transform((body) => ({
    student_id: body.student_id,
    day_date: body.day_date ?? null,
    plan_exercise_id: body.plan_exercise_id ?? null,
    text: body.text,
  }));

const StudentIdParamSchema = z.object({
  id: UuidSchema,
});

const FeedbackIdParamSchema = z.object({
  id: UuidSchema,
});

export function coachFeedbackRouter(deps: FeedbackRouterDeps): ExpressRouter {
  const router = Router();

  router.post(
    '/feedback',
    requireRole('coach'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const body = FeedbackBodySchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      if (body.data.plan_exercise_id) {
        const ownsExercise = await coachOwnsPublishedPlanExercise(
          deps.db,
          req.user.id,
          body.data.student_id,
          body.data.plan_exercise_id,
        );
        if (!ownsExercise) {
          res.status(400).json({ error: 'FEEDBACK_PLAN_EXERCISE_NOT_OWNED' });
          return;
        }
      } else {
        const ownsStudent = await coachHasPublishedPlanForStudent(
          deps.db,
          req.user.id,
          body.data.student_id,
        );
        if (!ownsStudent) {
          res.status(403).json({ error: 'AUTHORIZATION_FORBIDDEN' });
          return;
        }
      }

      const feedback = await createFeedback(deps.db, req.user.id, body.data);
      res.status(201).json(feedback);
    }),
  );

  return router;
}

export function studentFeedbackRouter(deps: FeedbackRouterDeps): ExpressRouter {
  const router = Router();

  router.get(
    '/:id/feedback',
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const params = StudentIdParamSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }

      if (uuidEquals(req.user.id, params.data.id)) {
        const items = await fetchOwnFeedback(deps.db, req.user.id);
        res.status(200).json({ items });
        return;
      }

      if (req.user.role !== 'coach') {
        res.status(403).json({ error: 'AUTHORIZATION_FORBIDDEN' });
        return;
      }

      const items = await fetchCoachFeedback(deps.db, req.user.id, params.data.id);
      res.status(200).json({ items });
    }),
  );

  return router;
}

export function feedbackRouter(deps: FeedbackRouterDeps): ExpressRouter {
  const router = Router();

  router.patch(
    '/:id/read',
    requireRole('coached_student', 'self_train_student'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const params = FeedbackIdParamSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }

      const updated = await markFeedbackRead(deps.db, params.data.id, req.user.id);
      if (!updated) {
        res.status(404).json({ error: 'FEEDBACK_NOT_FOUND' });
        return;
      }

      res.status(204).send();
    }),
  );

  return router;
}
