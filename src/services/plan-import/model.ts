import { z } from 'zod';

// Dates are optional model hints; keep only real ISO calendar dates.
const DateSchema = z.string().date().nullable().catch(null);
export const RegionSchema = z
  .object({
    r1: z.number().int().positive(),
    c1: z.number().int().positive(),
    r2: z.number().int().positive(),
    c2: z.number().int().positive(),
  })
  .refine((r) => r.r2 >= r.r1 && r.c2 >= r.c1);

export const OutlineSchema = z.object({
  sheet: z.string().min(1),
  header_region: z.preprocess(
    (value) =>
      value === undefined ||
      (typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.keys(value).length === 0)
        ? null
        : value,
    RegionSchema.nullable(),
  ),
  weeks: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        label: z.string().trim().nullable(),
        start_date: DateSchema,
        training_days: z.number().int().min(0).max(7),
        region: RegionSchema,
      }),
    )
    .refine((weeks) => new Set(weeks.map((week) => week.index)).size === weeks.length)
    .transform((weeks) =>
      weeks.map((week, index) => ({
        ...week,
        index,
        label: week.label === null || week.label === '' ? `W${String(index + 1)}` : week.label,
      })),
    ),
});

export type Cell = [number, number, string];
export interface Sheet {
  name: string;
  cells: Cell[];
}
export interface OutlineInput {
  sheets: Sheet[];
}
export interface WeekInput {
  index: number;
  cells: Cell[];
  header_cells: Cell[];
}
export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
}
export type UsageObserver = (usage: TokenUsage) => void;
export type Outline = z.infer<typeof OutlineSchema>;

export const SourceCellSchema = z.tuple([z.number().int().positive(), z.number().int().positive()]);

const UnparsedFieldSchema = z.object({ field: z.enum(['reps', 'intensity', 'weight']) });

// Match the editor's range separators and emit its canonical min-max notation.
const RepsSchema = z
  .string()
  .transform((text) =>
    text.replace(/^\s*(\d{1,2})\s*(?:-|–|—|~|到|至)\s*(\d{1,2})\s*(?:次|个)?\s*$/, '$1-$2'),
  )
  .refine((text) => {
    if (/^(?:\d+(?:\.\d+)?(?:\+|s)?)?$/.test(text)) return true;
    const range = /^(\d{1,2})-(\d{1,2})$/.exec(text);
    return (
      range !== null &&
      Number(range[1]) >= 1 &&
      Number(range[2]) >= Number(range[1]) &&
      Number(range[2]) <= 50
    );
  });

export const ExerciseSchema = z
  .object({
    source_cells: z.array(SourceCellSchema).default([]),
    unparsed: z.preprocess(
      (value) =>
        Array.isArray(value)
          ? value.filter((item) => UnparsedFieldSchema.safeParse(item).success)
          : value,
      z.array(UnparsedFieldSchema.extend({ text: z.string().trim().min(1).max(40) })).default([]),
    ),
    name: z.string().trim().min(1),
    sets: z.number().int().nonnegative(),
    reps: RepsSchema,
    intensity_kind: z.enum(['rpe', 'rir', 'pct']).nullable(),
    intensity_values: z.array(z.string().regex(/^\d+(?:\.\d+)?$/)),
    weight_values: z.array(z.string().regex(/^\d+(?:\.\d+)?$/)),
    note: z.string(),
    family_guess: z.enum(['squat', 'bench', 'deadlift']).nullable(),
    flags: z.array(z.enum(['note_fallback', 'inferred'])),
  })
  .superRefine((exercise, ctx) => {
    for (const field of ['intensity_values', 'weight_values'] as const) {
      const values = exercise[field];
      if (values.length !== 0 && values.length !== exercise.sets)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: 'SETS_VALUES_MISMATCH',
        });
    }
  });

// The model boundary validates structure only; exercise failures are handled separately.
export const WeekSkeletonSchema = z.object({
  index: z.number().int().nonnegative(),
  start_date: DateSchema,
  days: z
    .array(
      z
        .object({
          weekday: z.number().int().min(0).max(6).nullable(),
          day_index: z.number().int().positive(),
          rest: z.boolean(),
          exercises: z.array(z.unknown()),
        })
        .refine((day) => !day.rest || day.exercises.length === 0),
    )
    .max(7)
    .refine(
      (days) =>
        days.every((day) => day.weekday === null) ||
        (days.every((day) => day.weekday !== null) &&
          new Set(days.map((day) => day.weekday)).size === days.length),
    )
    .refine((days) =>
      days.every((day, index) => day.day_index > (days[index - 1]?.day_index ?? 0)),
    ),
});
export type WeekSkeleton = z.infer<typeof WeekSkeletonSchema>;
export type Exercise = z.infer<typeof ExerciseSchema>;
export type UnreadableExercise = {
  day_index: number;
  weekday: number | null;
  source_cells: [number, number][];
} & (
  | {
      reason: 'SETS_VALUES_MISMATCH';
      detail: { track: 'intensity' | 'weight'; sets: number; got: number };
    }
  | {
      reason: 'INVALID_NUMBER';
      detail: { track: 'intensity' | 'weight'; value: string };
    }
  | { reason: 'MISSING_NAME' | 'MISSING_SETS' | 'OTHER'; detail: null }
);
export type WeekResult = Omit<WeekSkeleton, 'days'> & {
  days: (Omit<WeekSkeleton['days'][number], 'exercises'> & { exercises: Exercise[] })[];
  unreadable: UnreadableExercise[];
};

export interface PlanImportModel {
  outline: (input: OutlineInput, onUsage?: UsageObserver) => Promise<Outline>;
  parseWeek: (input: WeekInput, onUsage?: UsageObserver) => Promise<WeekSkeleton>;
}
