import { Router, type Router as ExpressRouter } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import { hasAcceptedBond, hasOnboardingReadAccess } from '../db/bonds';
import type { Database } from '../db/types';
import {
  BENCH_GRIPS,
  DEADLIFT_STYLES,
  GENDERS,
  GYM_TIERS,
  INJURY_AREAS,
  MUSCLE_GROUPS,
  SQUAT_STANCES,
  TRAINING_DAYS,
  UNIT_PREFERENCES,
} from '../db/types';
import {
  completeOnboardingProfile,
  fetchOnboardingProfile,
  type OnboardingPatch,
  setStudentOneRm,
  upsertOnboardingProfile,
} from '../handlers/onboarding';
import { requireRole } from '../middleware/auth';
import { uuidEquals } from '../utils/uuid';
import { route, validationEnvelope } from './http';

interface OnboardingRouterDeps {
  db: Kysely<Database>;
}

const UuidSchema = z.string().uuid();
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

const IdParamSchema = z.object({
  id: UuidSchema,
});

/** Decimal-as-string per backend wire convention; normalized to N decimals. */
function decimalSchema(decimals: number, min: number, maxExclusive: number) {
  return z
    .union([z.string(), z.number()])
    .transform((value) => (typeof value === 'number' ? String(value) : value))
    .pipe(z.string().regex(/^\d+(\.\d{1,2})?$/, 'Decimal must have at most 2 decimals'))
    .refine(
      (value) => Number(value) > min && Number(value) < maxExclusive,
      `Value must be greater than ${String(min)} and less than ${String(maxExclusive)}`,
    )
    .transform((value) => Number(value).toFixed(decimals));
}

const HeightSchema = decimalSchema(1, 0, 300);
const WeightSchema = decimalSchema(2, 0, 500);
const OneRmSchema = decimalSchema(2, 0, 1000);
const ScaleSchema = z.number().int().min(1).max(5);

function uniqueItems(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

const OnboardingBodySchema = z
  .object({
    // Step 1
    unit_preference: z.enum(UNIT_PREFERENCES).optional(),
    gender: z.enum(GENDERS).optional(),
    birth_date: DateSchema.optional(),
    height_cm: HeightSchema.optional(),
    weight_kg: WeightSchema.optional(),
    // Step 2 (training_years: 0 = <1 year, 10 = 10+ years)
    training_years: z.number().int().min(0).max(10).optional(),
    squat_stance: z.enum(SQUAT_STANCES).optional(),
    deadlift_style: z.enum(DEADLIFT_STYLES).optional(),
    bench_grip: z.enum(BENCH_GRIPS).nullable().optional(),
    // Step 3
    squat_1rm_kg: OneRmSchema.optional(),
    bench_1rm_kg: OneRmSchema.optional(),
    deadlift_1rm_kg: OneRmSchema.optional(),
    // Step 4
    training_days: z
      .array(z.enum(TRAINING_DAYS))
      .min(2)
      .max(6)
      .refine(uniqueItems, 'training_days must be unique')
      .nullable()
      .optional(),
    gym_tier: z.enum(GYM_TIERS).optional(),
    equipment_overrides: z
      .array(z.string().trim().min(1).max(50))
      .max(30)
      .refine(uniqueItems, 'equipment_overrides must be unique')
      .nullable()
      .optional(),
    // Step 5
    daily_life_intensity: ScaleSchema.optional(),
    life_stress: ScaleSchema.optional(),
    recovery_speed: ScaleSchema.optional(),
    sleep_hours: ScaleSchema.optional(),
    // Step 6
    muscle_groups_to_strengthen: z
      .array(z.enum(MUSCLE_GROUPS))
      .max(3)
      .refine(uniqueItems, 'muscle_groups_to_strengthen must be unique')
      .nullable()
      .optional(),
    upload_attachment_ids: z
      .array(UuidSchema)
      .max(20)
      .refine(uniqueItems, 'upload_attachment_ids must be unique')
      .optional(),
    // Step 7
    injury_notes: z.string().trim().min(1).max(2000).nullable().optional(),
    injury_areas: z
      .array(z.enum(INJURY_AREAS))
      .max(8)
      .refine(uniqueItems, 'injury_areas must be unique')
      .nullable()
      .optional(),
    is_competing: z.boolean().optional(),
    competition_date: DateSchema.nullable().optional(),
    target_weight_class: z.string().trim().min(1).max(100).nullable().optional(),
    note_to_coach: z.string().trim().min(1).max(2000).nullable().optional(),
  })
  .strict();

const OneRmBodySchema = z
  .object({
    squat_1rm_kg: OneRmSchema.optional(),
    bench_1rm_kg: OneRmSchema.optional(),
    deadlift_1rm_kg: OneRmSchema.optional(),
  })
  .strict()
  .refine(
    (body) => Object.keys(body).length > 0,
    'At least one of squat_1rm_kg / bench_1rm_kg / deadlift_1rm_kg is required',
  );

export function studentOnboardingRouter(deps: OnboardingRouterDeps): ExpressRouter {
  const router = Router();

  router.put(
    '/me/onboarding',
    requireRole('coached_student', 'self_train_student'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const body = OnboardingBodySchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      const { upload_attachment_ids, ...fields } = body.data;
      const result = await upsertOnboardingProfile(
        deps.db,
        req.user.id,
        fields as OnboardingPatch,
        upload_attachment_ids,
      );
      if (result.type === 'one-rm-locked') {
        res.status(403).json({ error: 'ONE_RM_LOCKED' });
        return;
      }

      res.status(200).json(result.profile);
    }),
  );

  router.post(
    '/me/onboarding/complete',
    requireRole('coached_student', 'self_train_student'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const result = await completeOnboardingProfile(deps.db, req.user.id);
      if (result.type === 'incomplete') {
        res
          .status(422)
          .json({ error: 'ONBOARDING_INCOMPLETE', missing_fields: result.missingFields });
        return;
      }

      res.status(200).json(result.profile);
    }),
  );

  router.get(
    '/:id/onboarding',
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

      // Authorization: self / bonded coach / coach with a live pending bind
      // request (receive-queue "view full profile", spec 005 D16).
      const isSelf = uuidEquals(req.user.id, params.data.id);
      if (!isSelf) {
        if (req.user.role !== 'coach') {
          res.status(403).json({ error: 'AUTHORIZATION_FORBIDDEN' });
          return;
        }
        const allowed = await hasOnboardingReadAccess(deps.db, req.user.id, params.data.id);
        if (!allowed) {
          res.status(403).json({ error: 'AUTHORIZATION_FORBIDDEN' });
          return;
        }
      }

      const profile = await fetchOnboardingProfile(deps.db, params.data.id);
      if (!profile) {
        res.status(404).json({ error: 'ONBOARDING_NOT_FOUND' });
        return;
      }

      res.status(200).json(profile);
    }),
  );

  return router;
}

export function coachOneRmRouter(deps: OnboardingRouterDeps): ExpressRouter {
  const router = Router();

  router.put(
    '/students/:id/one-rm',
    requireRole('coach'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const params = IdParamSchema.safeParse(req.params);
      const body = OneRmBodySchema.safeParse(req.body);
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

      const result = await setStudentOneRm(deps.db, params.data.id, body.data);
      res.status(200).json(result);
    }),
  );

  return router;
}
