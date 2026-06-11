import { Router, type Router as ExpressRouter } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import { hasAcceptedBond } from '../db/bonds';
import type { Database } from '../db/types';
import {
  fetchEvaluationSummaryForCoach,
  fetchEvaluationSummaryForStudent,
  upsertEvaluationSummary,
} from '../handlers/evaluation-summary';
import {
  completeEvaluation,
  fetchEvaluationForPair,
  fetchEvaluationForStudent,
} from '../handlers/evaluations';
import { requireRole } from '../middleware/auth';
import { route, validationEnvelope } from './http';

interface EvaluationsRouterDeps {
  db: Kysely<Database>;
}

const IdParamSchema = z.object({
  id: z.string().uuid(),
});

const EvaluationSummaryBodySchema = z
  .object({
    overall_assessment: z.string().trim().min(1).max(10000),
    training_plan: z.string().trim().min(1).max(10000),
    words_to_student: z.string().trim().min(1).max(10000).nullable().optional(),
    notify_student: z.boolean(),
  })
  .strict();

export function coachEvaluationsRouter(deps: EvaluationsRouterDeps): ExpressRouter {
  const router = Router();

  router.get(
    '/students/:id/evaluation',
    requireRole('coach'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const params = IdParamSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }

      const evaluation = await fetchEvaluationForPair(deps.db, req.user.id, params.data.id);
      if (!evaluation) {
        res.status(404).json({ error: 'EVALUATION_NOT_FOUND' });
        return;
      }

      res.status(200).json(evaluation);
    }),
  );

  router.post(
    '/evaluations/:id/complete',
    requireRole('coach'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const params = IdParamSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }

      const result = await completeEvaluation(deps.db, req.user.id, params.data.id);
      if (result.type === 'not-found') {
        res.status(404).json({ error: 'EVALUATION_NOT_FOUND' });
        return;
      }
      if (result.type === 'already-completed') {
        res.status(409).json({ error: 'EVALUATION_ALREADY_COMPLETED' });
        return;
      }

      res.status(200).json(result.evaluationPeriod);
    }),
  );

  router.put(
    '/students/:id/evaluation-summary',
    requireRole('coach'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const params = IdParamSchema.safeParse(req.params);
      const body = EvaluationSummaryBodySchema.safeParse(req.body);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      const bonded = await hasAcceptedBond(deps.db, req.user.id, params.data.id);
      if (!bonded) {
        res.status(403).json({ error: 'AUTHORIZATION_FORBIDDEN' });
        return;
      }

      const summary = await upsertEvaluationSummary(deps.db, req.user.id, params.data.id, {
        overall_assessment: body.data.overall_assessment,
        training_plan: body.data.training_plan,
        words_to_student: body.data.words_to_student ?? null,
        notify_student: body.data.notify_student,
      });
      res.status(200).json(summary);
    }),
  );

  return router;
}

export function studentEvaluationsRouter(deps: EvaluationsRouterDeps): ExpressRouter {
  const router = Router();

  router.get(
    '/me/evaluation',
    requireRole('coached_student', 'self_train_student'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const evaluation = await fetchEvaluationForStudent(deps.db, req.user.id);
      if (!evaluation) {
        res.status(404).json({ error: 'EVALUATION_NOT_FOUND' });
        return;
      }

      res.status(200).json(evaluation);
    }),
  );

  router.get(
    '/:id/evaluation-summary',
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const params = IdParamSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }

      if (req.user.id === params.data.id) {
        const summary = await fetchEvaluationSummaryForStudent(deps.db, req.user.id);
        if (!summary) {
          res.status(404).json({ error: 'EVALUATION_SUMMARY_NOT_FOUND' });
          return;
        }
        res.status(200).json(summary);
        return;
      }

      if (req.user.role !== 'coach') {
        res.status(403).json({ error: 'AUTHORIZATION_FORBIDDEN' });
        return;
      }

      const bonded = await hasAcceptedBond(deps.db, req.user.id, params.data.id);
      if (!bonded) {
        res.status(403).json({ error: 'AUTHORIZATION_FORBIDDEN' });
        return;
      }

      // Coach reads only the summary they authored (multi-coach leak guard).
      const summary = await fetchEvaluationSummaryForCoach(deps.db, req.user.id, params.data.id);
      if (!summary) {
        res.status(404).json({ error: 'EVALUATION_SUMMARY_NOT_FOUND' });
        return;
      }
      res.status(200).json(summary);
    }),
  );

  return router;
}
