import { z } from 'zod';

import {
  API_PLAN_SOURCES,
  INTENSITY_MODES,
  LOAD_MODES,
  PCT_ANCHORS,
  PATCHABLE_PLAN_STATUSES,
  PLAN_KINDS,
  SET_TYPES,
} from '../../db/types';
import {
  intensityState,
  usesNewIntensityShape,
  validateIntensityState,
  validateIntensityValues,
} from './intensity';

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');
const UuidSchema = z.string().uuid();
const NameSchema = z.string().trim().min(1).max(120);
// Relaxed from {1, 4} to any 1..52 weeks for imported multi-week plans (spec 043
// §G). The DB CHECK (migration 0020) and SMALLINT column mirror this range.
const PlanWeeksSchema = z.number().int().min(1).max(52);
const OneRmKgSchema = z.number().positive().max(999.99);
const SourceTemplateIdSchema = z.string().uuid().nullable().optional();
const SortOrderSchema = z.number().int().min(0);
const DayOfWeekSchema = z.number().int().min(1).max(7);
const WeekNumberSchema = z.number().int().min(1).max(52);
const PositiveRepsSchema = z.number().int().min(1).max(50);

const TargetValueSchema = z
  .union([z.string(), z.number()])
  .transform((value) => (typeof value === 'number' ? String(value) : value))
  .pipe(z.string().regex(/^\d+(\.\d{1,2})?$/, 'target_value must have at most 2 decimals'));

export const IdParamSchema = z.object({
  id: UuidSchema,
});

export const PendingRevisionBodySchema = z
  .object({
    version: z.number().int().min(1),
    content_hash: z.string().min(1).max(64),
    content: z.record(z.unknown()),
  })
  .strict();

export const DayIdParamSchema = z.object({
  dayId: UuidSchema,
});

export const ExerciseIdParamSchema = z.object({
  exerciseId: UuidSchema,
});

export const SetIdParamSchema = z.object({
  setId: UuidSchema,
});

export const StudentPlansParamSchema = z.object({
  studentId: UuidSchema,
});

function validateDateOrder(
  data: { start_date?: string | undefined; end_date?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (data.start_date && data.end_date && data.end_date < data.start_date) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['end_date'],
      message: 'end_date must be on or after start_date',
    });
  }
}

function validateSourceTemplate(
  data: {
    source?: 'coach' | 'template' | undefined;
    source_template_id?: string | null | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (data.source === 'template' && !data.source_template_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['source_template_id'],
      message: 'source_template_id is required for template plans',
    });
  }
  if (data.source === 'coach' && data.source_template_id != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['source_template_id'],
      message: 'source_template_id must be null for coach plans',
    });
  }
}

export const CreatePlanBodySchema = z
  .object({
    trainee_id: UuidSchema,
    name: NameSchema,
    start_date: DateSchema,
    end_date: DateSchema,
    plan_weeks: PlanWeeksSchema,
    source: z.enum(API_PLAN_SOURCES),
    source_template_id: SourceTemplateIdSchema,
    // Defaults to 'regular'; immutable after creation (spec 005 D9).
    kind: z.enum(PLAN_KINDS).optional(),
    // Raw true 1RM input only; the server computes and stores training_max.
    one_rm_kg: OneRmKgSchema.optional(),
    // spec 037: D1 weekday display anchor may be set at creation time too.
    anchor_weekday: z.number().int().min(1).max(7).nullable().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    validateDateOrder(data, ctx);
    validateSourceTemplate(data, ctx);
    // Adaptation week plans are always exactly 1 week (evaluation-workflow §4.2).
    if (data.kind === 'adaptation' && data.plan_weeks !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['plan_weeks'],
        message: 'Adaptation plans must be exactly 1 week',
      });
    }
  });

export const PatchPlanBodySchema = z
  .object({
    name: NameSchema.optional(),
    start_date: DateSchema.optional(),
    end_date: DateSchema.optional(),
    plan_weeks: PlanWeeksSchema.optional(),
    status: z.enum(PATCHABLE_PLAN_STATUSES).optional(),
    source_template_id: SourceTemplateIdSchema,
    // Raw true 1RM input only; direct training_max writes stay rejected by strict().
    one_rm_kg: OneRmKgSchema.optional(),
    // spec 037: D1 weekday display anchor (1=Mon … 7=Sun); null clears it.
    anchor_weekday: z.number().int().min(1).max(7).nullable().optional(),
  })
  .strict()
  .superRefine(validateDateOrder);

export const CreatePlanDayBodySchema = z.object({
  day_of_week: DayOfWeekSchema,
  week_number: WeekNumberSchema,
  sort_order: SortOrderSchema,
});

export const PatchPlanDayBodySchema = CreatePlanDayBodySchema.partial();

export const CreatePlanExerciseBodySchema = z.object({
  exercise_id: UuidSchema,
  is_main_lift: z.boolean(),
  sort_order: SortOrderSchema,
  notes: z.string().max(500).nullable().optional(),
  // spec 037 v1.1: coach-chosen 目标 label — competition lift or muscle-group
  // token; null clears back to "no target".
  target: z
    .string()
    .regex(/^[a-z_]{1,32}$/, 'target must be a lowercase token')
    .nullable()
    .optional(),
});

export const PatchPlanExerciseBodySchema = CreatePlanExerciseBodySchema.partial();

interface SetBodyValidationShape {
  target_reps?: number | undefined;
  target_reps_max?: number | null | undefined;
  intensity_mode?: 'weight' | 'rpe' | undefined;
  target_value?: string | undefined;
  load_mode?: (typeof LOAD_MODES)[number] | null | undefined;
  pct_anchor?: (typeof PCT_ANCHORS)[number] | null | undefined;
  target_pct?: string | null | undefined;
  target_rpe?: string | null | undefined;
  rir_target?: string | null | undefined;
  rpe_low?: string | null | undefined;
  rpe_high?: string | null | undefined;
  weight_low?: string | null | undefined;
  weight_high?: string | null | undefined;
  target_weight?: string | null | undefined;
}

function validateSetCommon(data: SetBodyValidationShape, ctx: z.RefinementCtx): void {
  if (
    data.target_reps !== undefined &&
    data.target_reps_max !== undefined &&
    data.target_reps_max !== null &&
    data.target_reps_max < data.target_reps
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['target_reps_max'],
      message: 'target_reps_max must be greater than or equal to target_reps',
    });
  }
}

function validateLegacyIntensity(
  data: {
    intensity_mode?: 'weight' | 'rpe' | undefined;
    target_value?: string | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (data.intensity_mode && data.target_value) {
    const numericValue = Number(data.target_value);
    if (data.intensity_mode === 'rpe' && (numericValue < 1 || numericValue > 10)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['target_value'],
        message: 'RPE target_value must be between 1.0 and 10.0',
      });
    }
    if (data.intensity_mode === 'weight' && (numericValue <= 0 || numericValue >= 1000)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['target_value'],
        message: 'Weight target_value must be greater than 0 and less than 1000',
      });
    }
  }
}

function addIntensityIssues(
  issues: ReturnType<typeof validateIntensityState>,
  ctx: z.RefinementCtx,
): void {
  for (const issue of issues) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, ...issue });
  }
}

const PlanSetBodySchema = z.object({
  set_number: z.number().int().min(1),
  target_reps: PositiveRepsSchema,
  target_reps_max: PositiveRepsSchema.nullable().optional(),
  intensity_mode: z.enum(INTENSITY_MODES).optional(),
  target_value: TargetValueSchema.optional(),
  load_mode: z.enum(LOAD_MODES).nullable().optional(),
  pct_anchor: z.enum(PCT_ANCHORS).nullable().optional(),
  target_pct: TargetValueSchema.nullable().optional(),
  target_rpe: TargetValueSchema.nullable().optional(),
  rir_target: TargetValueSchema.nullable().optional(),
  rpe_low: TargetValueSchema.nullable().optional(),
  rpe_high: TargetValueSchema.nullable().optional(),
  weight_low: TargetValueSchema.nullable().optional(),
  weight_high: TargetValueSchema.nullable().optional(),
  target_weight: TargetValueSchema.nullable().optional(),
  set_type: z.enum(SET_TYPES),
  rest_seconds: z.number().int().min(0).max(3600).nullable().optional(),
  // Student-visible cue carried alongside the structured target (spec 043 §G).
  coach_note: z.string().max(500).nullable().optional(),
});

export const CreatePlanSetBodySchema = PlanSetBodySchema.superRefine((data, ctx) => {
  validateSetCommon(data, ctx);
  if (usesNewIntensityShape(data)) {
    if (data.load_mode === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['load_mode'],
        message: 'load_mode is required when using the intensity system',
      });
      return;
    }
    addIntensityIssues(validateIntensityState(intensityState(data)), ctx);
    return;
  }

  if (data.intensity_mode === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['intensity_mode'],
      message: 'intensity_mode is required',
    });
  }
  if (data.target_value === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['target_value'],
      message: 'target_value is required',
    });
  }
  validateLegacyIntensity(data, ctx);
});

export const PatchPlanSetBodySchema = PlanSetBodySchema.partial().superRefine((data, ctx) => {
  validateSetCommon(data, ctx);
  if (usesNewIntensityShape(data)) {
    addIntensityIssues(validateIntensityValues(intensityState(data)), ctx);
  } else {
    validateLegacyIntensity(data, ctx);
  }
});

const MAX_UPSERT_DAYS = 100;
const MAX_DELETE_IDS = 400;
const MAX_EXERCISES_PER_DAY = 30;
const MAX_SETS_PER_EXERCISE = 30;

const BatchExerciseSchema = z.object({
  exercise_id: UuidSchema,
  is_main_lift: z.boolean(),
  sort_order: SortOrderSchema,
  notes: z.string().max(500).nullable().optional(),
  target: z
    .string()
    .regex(/^[a-z_]{1,32}$/, 'target must be a lowercase token')
    .nullable()
    .optional(),
  sets: z.array(CreatePlanSetBodySchema).max(MAX_SETS_PER_EXERCISE),
});

const BatchDaySchema = z.object({
  week_number: WeekNumberSchema,
  day_of_week: DayOfWeekSchema,
  sort_order: SortOrderSchema,
  exercises: z.array(BatchExerciseSchema).max(MAX_EXERCISES_PER_DAY),
});

const BatchPlanPatchSchema = z
  .object({
    name: NameSchema.optional(),
    start_date: DateSchema.optional(),
    end_date: DateSchema.optional(),
    plan_weeks: PlanWeeksSchema.optional(),
  })
  .strict()
  .superRefine(validateDateOrder);

export const BatchDaysBodySchema = z
  .object({
    plan_patch: BatchPlanPatchSchema.optional(),
    delete_day_ids: z.array(UuidSchema).max(MAX_DELETE_IDS).default([]),
    upsert_days: z.array(BatchDaySchema).max(MAX_UPSERT_DAYS).default([]),
  })
  .strict();

/** Explicit confirmation prevents a normal plan load from inventing history. */
export const ImportedHistoryBodySchema = z.object({ confirm: z.literal(true) }).strict();

const PlanStatusQuerySchema = z.enum(['draft', 'published', 'completed', 'paused']);

function splitCsvParam(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const rawValues = Array.isArray(value) ? value : [value];
  return rawValues
    .flatMap((item) => (typeof item === 'string' ? item.split(',') : []))
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export const StudentPlansQuerySchema = z
  .object({
    status: z.unknown().optional(),
  })
  .transform((query, ctx) => {
    const statuses = splitCsvParam(query.status);
    if (statuses === undefined) return {};
    const parsedStatuses: z.infer<typeof PlanStatusQuerySchema>[] = [];
    for (const status of statuses) {
      const parsed = PlanStatusQuerySchema.safeParse(status);
      if (!parsed.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['status'],
          message: 'Invalid status filter',
        });
        return z.NEVER;
      }
      parsedStatuses.push(parsed.data);
    }

    if (parsedStatuses.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'Invalid status filter',
      });
      return z.NEVER;
    }
    return { status: parsedStatuses };
  });

export type CreatePlanBody = z.infer<typeof CreatePlanBodySchema>;
export type PatchPlanBody = z.infer<typeof PatchPlanBodySchema>;
export type CreatePlanDayBody = z.infer<typeof CreatePlanDayBodySchema>;
export type PatchPlanDayBody = z.infer<typeof PatchPlanDayBodySchema>;
export type CreatePlanExerciseBody = z.infer<typeof CreatePlanExerciseBodySchema>;
export type PatchPlanExerciseBody = z.infer<typeof PatchPlanExerciseBodySchema>;
export type CreatePlanSetBody = z.infer<typeof CreatePlanSetBodySchema>;
export type PatchPlanSetBody = z.infer<typeof PatchPlanSetBodySchema>;
export type BatchDaysBody = z.infer<typeof BatchDaysBodySchema>;
export type ImportedHistoryBody = z.infer<typeof ImportedHistoryBodySchema>;
