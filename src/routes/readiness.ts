import { Router, type Router as ExpressRouter } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import { hasAcceptedBond } from '../db/bonds';
import type { Database } from '../db/types';
import { READINESS_MUSCLE_GROUPS } from '../db/types';
import { fetchReadinessCheckin } from '../handlers/readiness-fetch';
import { upsertReadinessCheckin } from '../handlers/readiness-submit';
import { requireRole } from '../middleware/auth';
import { route, validationEnvelope } from './http';

interface ReadinessRouterDeps {
  db: Kysely<Database>;
}

const UuidSchema = z.string().uuid();
const DateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
  // Roundtrip check: Date.parse alone lets impossible days (2026-02-30) roll over.
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'Date must be a valid calendar date');
const ScaleSchema = z.number().int().min(1).max(5);

const MuscleFatigueEntrySchema = z
  .object({
    muscle_group: z.enum(READINESS_MUSCLE_GROUPS),
    severity: z.number().int().min(1).max(3),
  })
  .strict();

const ReadinessBodySchema = z
  .object({
    checkin_date: DateSchema,
    sleep_quality: ScaleSchema,
    mood: ScaleSchema,
    stress: ScaleSchema,
    muscle_fatigue: z
      .array(MuscleFatigueEntrySchema)
      .max(READINESS_MUSCLE_GROUPS.length)
      .refine(
        (entries) => new Set(entries.map((entry) => entry.muscle_group)).size === entries.length,
        'muscle_fatigue muscle_group must be unique',
      ),
  })
  .strict();

const StudentIdParamSchema = z.object({
  id: UuidSchema,
});

const ReadinessQuerySchema = z
  .object({
    date: DateSchema,
  })
  .strict();

export function studentReadinessRouter(deps: ReadinessRouterDeps): ExpressRouter {
  const router = Router();

  // Route order is load-bearing: the literal `me` segment must be registered
  // before `/:id/readiness`, or Express would swallow `me` as a UUID param
  // (spec 030 §C7).
  router.post(
    '/me/readiness',
    requireRole('coached_student', 'self_train_student'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const body = ReadinessBodySchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      const result = await upsertReadinessCheckin(deps.db, req.user.id, body.data);
      // Upsert semantics: overwriting the same day still returns 201
      // (aligned with POST /sets/log).
      res.status(201).json(result);
    }),
  );

  router.get(
    '/:id/readiness',
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
      const query = ReadinessQuerySchema.safeParse(req.query);
      if (!query.success) {
        res.status(400).json(validationEnvelope(query.error));
        return;
      }

      // Authorization matrix mirrors GET /students/:id/sets: student self,
      // or coach with an accepted bind; everyone else 403.
      const isSelf = req.user.id === params.data.id;
      if (!isSelf) {
        if (req.user.role !== 'coach') {
          res.status(403).json({ error: 'AUTHORIZATION_FORBIDDEN' });
          return;
        }
        const bonded = await hasAcceptedBond(deps.db, req.user.id, params.data.id);
        if (!bonded) {
          res.status(403).json({ error: 'AUTHORIZATION_FORBIDDEN' });
          return;
        }
      }

      const checkin = await fetchReadinessCheckin(deps.db, params.data.id, query.data.date);
      res.status(200).json({ checkin });
    }),
  );

  return router;
}
