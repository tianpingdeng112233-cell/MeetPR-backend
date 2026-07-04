import { Router, type Router as ExpressRouter } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { Database } from '../db/types';
import { fetchCoachSetLogs, fetchOwnSetLogs } from '../handlers/sets-fetch';
import {
  exerciseExists,
  resolvePlanExercise,
  upsertAdhocSetLog,
  upsertSetLog,
} from '../handlers/sets-log';
import { requireRole } from '../middleware/auth';
import { uuidEquals } from '../utils/uuid';
import { route, validationEnvelope } from './http';

interface SetsRouterDeps {
  db: Kysely<Database>;
}

const UuidSchema = z.string().uuid();
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');
const DecimalSchema = z
  .union([z.string(), z.number()])
  .transform((value) => (typeof value === 'number' ? String(value) : value))
  .pipe(z.string().regex(/^\d+(\.\d{1,2})?$/, 'Decimal must have at most 2 decimals'));
const RpeSchema = z
  .union([z.string(), z.number()])
  .transform((value) => (typeof value === 'number' ? String(value) : value))
  .pipe(z.string().regex(/^\d+(\.\d)?$/, 'RPE must have at most 1 decimal'))
  .refine((value) => Number(value) >= 0 && Number(value) <= 10, 'RPE must be between 0 and 10');

const SetLogCommonFields = {
  set_index: z.number().int().min(0),
  weight_kg: DecimalSchema.refine(
    (value) => Number(value) >= 0 && Number(value) <= 9999.99,
    'weight_kg must be between 0 and 9999.99',
  ),
  reps: z.number().int().min(0).max(99),
  rpe: RpeSchema.nullable().optional(),
  completed: z.boolean(),
  failed: z.boolean().optional(),
};

interface SetLogCommonShape {
  weight_kg: string;
  rpe?: string | null | undefined;
  failed?: boolean | undefined;
}

function normalizeSetLogBody<T extends SetLogCommonShape>(body: T) {
  return {
    ...body,
    failed: body.failed ?? false,
    weight_kg: Number(body.weight_kg).toFixed(2),
    rpe: body.rpe == null ? null : Number(body.rpe).toFixed(1),
  };
}

// Two mutually exclusive body shapes (spec 010): coached sets point at a plan
// slot (logged_date optional for old-build compatibility); adhoc sets point
// straight at an exercise and must carry the client-local logged_date.
const CoachedSetLogBodySchema = z
  .object({
    plan_exercise_id: UuidSchema,
    logged_date: DateSchema.optional(),
    ...SetLogCommonFields,
  })
  .strict()
  .transform(normalizeSetLogBody);

const AdhocSetLogBodySchema = z
  .object({
    exercise_id: UuidSchema,
    logged_date: DateSchema,
    ...SetLogCommonFields,
  })
  .strict()
  .transform(normalizeSetLogBody);

const SetLogBodySchema = z.union([CoachedSetLogBodySchema, AdhocSetLogBodySchema]);

/** Server-clock training day for old clients that do not send logged_date. */
function shanghaiToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

const StudentIdParamSchema = z.object({
  id: UuidSchema,
});

const SetLogQuerySchema = z
  .object({
    from: DateSchema,
    to: DateSchema,
  })
  .strict()
  .refine((query) => query.to >= query.from, {
    path: ['to'],
    message: 'to must be on or after from',
  });

function dateStart(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

export function setsRouter(deps: SetsRouterDeps): ExpressRouter {
  const router = Router();

  router.post(
    '/log',
    requireRole('coached_student', 'self_train_student'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const body = SetLogBodySchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      if ('plan_exercise_id' in body.data) {
        const resolved = await resolvePlanExercise(
          deps.db,
          body.data.plan_exercise_id,
          req.user.id,
        );
        if (resolved === null) {
          res.status(400).json({ error: 'SETS_PLAN_EXERCISE_NOT_PUBLISHED' });
          return;
        }

        const result = await upsertSetLog(deps.db, req.user.id, {
          plan_exercise_id: body.data.plan_exercise_id,
          exercise_id: resolved.exerciseId,
          logged_date: body.data.logged_date ?? shanghaiToday(),
          set_index: body.data.set_index,
          weight_kg: body.data.weight_kg,
          reps: body.data.reps,
          rpe: body.data.rpe,
          completed: body.data.completed,
          failed: body.data.failed,
        });
        res.status(201).json(result);
        return;
      }

      const known = await exerciseExists(deps.db, body.data.exercise_id);
      if (!known) {
        res.status(400).json({ error: 'SETS_EXERCISE_NOT_FOUND' });
        return;
      }

      const result = await upsertAdhocSetLog(deps.db, req.user.id, {
        exercise_id: body.data.exercise_id,
        logged_date: body.data.logged_date,
        set_index: body.data.set_index,
        weight_kg: body.data.weight_kg,
        reps: body.data.reps,
        rpe: body.data.rpe,
        completed: body.data.completed,
        failed: body.data.failed,
      });
      res.status(201).json(result);
    }),
  );

  return router;
}

export function studentSetsRouter(deps: SetsRouterDeps): ExpressRouter {
  const router = Router();

  router.get(
    '/:id/sets',
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const params = StudentIdParamSchema.safeParse(req.params);
      const query = SetLogQuerySchema.safeParse(req.query);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }
      if (!query.success) {
        res.status(400).json(validationEnvelope(query.error));
        return;
      }

      const from = dateStart(query.data.from);
      const to = dateStart(query.data.to);
      if (uuidEquals(req.user.id, params.data.id)) {
        const logs = await fetchOwnSetLogs(deps.db, req.user.id, from, to);
        res.status(200).json({ logs });
        return;
      }

      if (req.user.role !== 'coach') {
        res.status(403).json({ error: 'AUTHORIZATION_FORBIDDEN' });
        return;
      }

      const logs = await fetchCoachSetLogs(deps.db, req.user.id, params.data.id, from, to);
      res.status(200).json({ logs });
    }),
  );

  return router;
}
