import type { ColumnType, Generated } from 'kysely';

export const USER_ROLES = ['coach', 'coached_student', 'self_train_student'] as const;
export const LIFT_FAMILIES = ['squat', 'bench', 'deadlift'] as const;
export const EXERCISE_TYPES = ['main_lift', 'main_lift_variation', 'accessory'] as const;
export const MUSCLE_GROUPS = [
  'chest',
  'shoulder',
  'back',
  'biceps',
  'triceps',
  'core',
  'quad',
  'hamstring',
  'glute',
] as const;
export const EQUIPMENT = ['barbell', 'dumbbell', 'machine', 'bodyweight'] as const;
export const MOVEMENT_PATTERNS = ['push', 'pull'] as const;
export const PLAN_SOURCES = ['coach', 'template', 'algorithm'] as const;
export const API_PLAN_SOURCES = ['coach', 'template'] as const;
export const PLAN_STATUSES = ['draft', 'published', 'completed', 'paused'] as const;
export const PATCHABLE_PLAN_STATUSES = ['published', 'paused', 'completed'] as const;
export const INTENSITY_MODES = ['weight', 'rpe'] as const;
export const SET_TYPES = ['warmup', 'working', 'failed', 'amrap', 'backoff'] as const;

export type UserRole = (typeof USER_ROLES)[number];
export type LiftFamily = (typeof LIFT_FAMILIES)[number];
export type ExerciseType = (typeof EXERCISE_TYPES)[number];
export type MuscleGroup = (typeof MUSCLE_GROUPS)[number];
export type Equipment = (typeof EQUIPMENT)[number];
export type MovementPattern = (typeof MOVEMENT_PATTERNS)[number];
export type PlanSource = (typeof PLAN_SOURCES)[number];
export type ApiPlanSource = (typeof API_PLAN_SOURCES)[number];
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export type PatchablePlanStatus = (typeof PATCHABLE_PLAN_STATUSES)[number];
export type IntensityMode = (typeof INTENSITY_MODES)[number];
export type SetType = (typeof SET_TYPES)[number];

type NullableColumn<T> = ColumnType<T | null, T | null | undefined, T | null>;
type TimestampColumn = ColumnType<Date, Date | undefined, Date>;

export interface UsersTable {
  id: Generated<string>;
  phone: string;
  apple_user_id: NullableColumn<string>;
  password_hash: string;
  role: UserRole;
  refresh_token_jti: NullableColumn<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ExercisesTable {
  id: Generated<string>;
  name: string;
  exercise_type: ExerciseType;
  main_lift_family: NullableColumn<LiftFamily>;
  is_competition_lift: Generated<boolean>;
  muscle_groups: MuscleGroup[];
  equipment: Equipment[];
  movement_pattern: Generated<MovementPattern[]>;
  created_by_coach_id: NullableColumn<string>;
  created_at: TimestampColumn;
}

export interface PlansTable {
  id: Generated<string>;
  coach_id: NullableColumn<string>;
  trainee_id: string;
  name: string;
  start_date: string;
  end_date: string;
  plan_weeks: number;
  source: PlanSource;
  source_template_id: NullableColumn<string>;
  status: Generated<PlanStatus>;
  created_at: TimestampColumn;
  updated_at: TimestampColumn;
}

export interface PlanDaysTable {
  id: Generated<string>;
  plan_id: string;
  day_of_week: number;
  week_number: number;
  sort_order: Generated<number>;
}

export interface PlanExercisesTable {
  id: Generated<string>;
  plan_day_id: string;
  exercise_id: string;
  is_main_lift: Generated<boolean>;
  sort_order: Generated<number>;
  notes: NullableColumn<string>;
}

export interface PlanSetsTable {
  id: Generated<string>;
  plan_exercise_id: string;
  set_number: number;
  target_reps: number;
  target_reps_max: NullableColumn<number>;
  intensity_mode: IntensityMode;
  target_value: string;
  set_type: SetType;
  created_at: TimestampColumn;
}

export interface Database {
  users: UsersTable;
  exercises: ExercisesTable;
  plans: PlansTable;
  plan_days: PlanDaysTable;
  plan_exercises: PlanExercisesTable;
  plan_sets: PlanSetsTable;
  // coach_profiles: CoachProfilesTable;
  // student_profiles: StudentProfilesTable;
}
