import { z } from 'zod';

const DateSchema = z.string().date().nullable();
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
  header_region: RegionSchema.nullable(),
  weeks: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        label: z.string().trim().min(1),
        start_date: DateSchema,
        training_days: z.number().int().min(0).max(7),
        region: RegionSchema,
      }),
    )
    .refine((weeks) => new Set(weeks.map((week) => week.index)).size === weeks.length),
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

const ExerciseSchema = z
  .object({
    name: z.string().trim().min(1),
    sets: z.number().int().nonnegative(),
    reps: z.string().regex(/^(?:\d+(?:\.\d+)?(?:\+|s)?)?$/),
    intensity_kind: z.enum(['rpe', 'rir', 'pct']).nullable(),
    intensity_values: z.array(z.string().regex(/^\d+(?:\.\d+)?$/)),
    weight_values: z.array(z.string().regex(/^\d+(?:\.\d+)?$/)),
    note: z.string(),
    family_guess: z.enum(['squat', 'bench', 'deadlift']).nullable(),
    flags: z.array(z.enum(['note_fallback', 'inferred'])),
  })
  .refine((exercise) =>
    [exercise.intensity_values, exercise.weight_values].every(
      (values) => values.length === 0 || values.length === exercise.sets,
    ),
  );

export const WeekResultSchema = z.object({
  index: z.number().int().nonnegative(),
  start_date: DateSchema,
  days: z
    .array(
      z
        .object({
          weekday: z.number().int().min(0).max(6),
          rest: z.boolean(),
          exercises: z.array(ExerciseSchema),
        })
        .refine((day) => !day.rest || day.exercises.length === 0),
    )
    .max(7)
    .refine((days) => new Set(days.map((day) => day.weekday)).size === days.length),
});
export type WeekResult = z.infer<typeof WeekResultSchema>;

export interface PlanImportModel {
  outline: (input: OutlineInput, onUsage?: UsageObserver) => Promise<Outline>;
  parseWeek: (input: WeekInput, onUsage?: UsageObserver) => Promise<WeekResult>;
}
