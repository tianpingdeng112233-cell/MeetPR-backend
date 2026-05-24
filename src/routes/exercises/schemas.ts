import { z } from 'zod';

import {
  EQUIPMENT,
  EXERCISE_TYPES,
  LIFT_FAMILIES,
  MOVEMENT_PATTERNS,
  MUSCLE_GROUPS,
} from '../../db/types';

const csvParam = <T extends string>(allowed: readonly T[], path: string) =>
  z
    .unknown()
    .optional()
    .transform((value, ctx): T[] | undefined => {
      if (value === undefined) return undefined;
      const rawValues = Array.isArray(value) ? value : [value];
      const values = rawValues
        .flatMap((item) => (typeof item === 'string' ? item.split(',') : []))
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

      const parsedValues: T[] = [];
      for (const item of values) {
        if (!allowed.includes(item as T)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [path],
            message: `Invalid ${path} filter`,
          });
          return z.NEVER;
        }
        parsedValues.push(item as T);
      }

      return parsedValues;
    });

const ExerciseTypeSchema = z.enum(EXERCISE_TYPES);
const LiftFamilySchema = z.enum(LIFT_FAMILIES);
const MuscleGroupSchema = z.enum(MUSCLE_GROUPS);
const EquipmentSchema = z.enum(EQUIPMENT);
const MovementPatternSchema = z.enum(MOVEMENT_PATTERNS);

export const ExerciseQuerySchema = z.object({
  muscle_group: csvParam(MUSCLE_GROUPS, 'muscle_group'),
  equipment: csvParam(EQUIPMENT, 'equipment'),
  movement_pattern: csvParam(MOVEMENT_PATTERNS, 'movement_pattern'),
  exercise_type: csvParam(EXERCISE_TYPES, 'exercise_type'),
  main_lift_family: csvParam(LIFT_FAMILIES, 'main_lift_family'),
});

export const CreateExerciseBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    exercise_type: ExerciseTypeSchema,
    main_lift_family: LiftFamilySchema.nullable().optional(),
    is_competition_lift: z.boolean(),
    muscle_groups: z.array(MuscleGroupSchema).min(1).max(MUSCLE_GROUPS.length),
    equipment: z.array(EquipmentSchema).min(1).max(EQUIPMENT.length),
    movement_pattern: z.array(MovementPatternSchema).max(MOVEMENT_PATTERNS.length),
  })
  .superRefine((data, ctx) => {
    if (data.exercise_type === 'accessory' && data.main_lift_family != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['main_lift_family'],
        message: 'main_lift_family must be null for accessories',
      });
    }
    if (data.exercise_type !== 'accessory' && !data.main_lift_family) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['main_lift_family'],
        message: 'main_lift_family is required for main lifts',
      });
    }
  });

export type ExerciseQuery = z.infer<typeof ExerciseQuerySchema>;
export type CreateExerciseBody = z.infer<typeof CreateExerciseBodySchema>;
