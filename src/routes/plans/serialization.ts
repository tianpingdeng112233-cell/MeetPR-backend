import type { Selectable } from 'kysely';

import type {
  ExercisesTable,
  PlanDaysTable,
  PlanExercisesTable,
  PlansTable,
  PlanSetsTable,
} from '../../db/types';

type TimestampValue = Date | string;

function timestamp(value: TimestampValue): string {
  return value instanceof Date ? value.toISOString() : value;
}

export type PlanRow = Selectable<PlansTable>;
export type PlanDayRow = Selectable<PlanDaysTable>;
export type PlanExerciseRow = Selectable<PlanExercisesTable>;
export type PlanSetRow = Selectable<PlanSetsTable>;
export type ExerciseRow = Selectable<ExercisesTable>;

export interface PlanResponse {
  id: string;
  coach_id: string | null;
  trainee_id: string;
  name: string;
  start_date: string;
  end_date: string;
  plan_weeks: number;
  source: PlanRow['source'];
  source_template_id: string | null;
  status: PlanRow['status'];
  created_at: string;
  updated_at: string;
}

export interface PlanSetResponse {
  id: string;
  plan_exercise_id: string;
  set_number: number;
  target_reps: number;
  target_reps_max: number | null;
  intensity_mode: PlanSetRow['intensity_mode'];
  target_value: string;
  set_type: PlanSetRow['set_type'];
  created_at: string;
}

export interface PlanExerciseResponse {
  id: string;
  plan_day_id: string;
  exercise_id: string;
  is_main_lift: boolean;
  sort_order: number;
  notes: string | null;
  sets: PlanSetResponse[];
}

export interface PlanDayResponse {
  id: string;
  plan_id: string;
  day_of_week: number;
  week_number: number;
  sort_order: number;
  exercises: PlanExerciseResponse[];
}

export interface PlanWithChildrenResponse extends PlanResponse {
  days: PlanDayResponse[];
}

export interface ExerciseResponse {
  id: string;
  name: string;
  exercise_type: ExerciseRow['exercise_type'];
  main_lift_family: ExerciseRow['main_lift_family'];
  is_competition_lift: boolean;
  muscle_groups: ExerciseRow['muscle_groups'];
  equipment: ExerciseRow['equipment'];
  movement_pattern: ExerciseRow['movement_pattern'];
  created_by_coach_id: string | null;
  created_at: string;
}

export function toPlan(row: PlanRow): PlanResponse {
  return {
    id: row.id,
    coach_id: row.coach_id,
    trainee_id: row.trainee_id,
    name: row.name,
    start_date: row.start_date,
    end_date: row.end_date,
    plan_weeks: row.plan_weeks,
    source: row.source,
    source_template_id: row.source_template_id,
    status: row.status,
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at),
  };
}

export function toPlanDay(
  row: PlanDayRow,
  exercises: PlanExerciseResponse[] = [],
): PlanDayResponse {
  return {
    id: row.id,
    plan_id: row.plan_id,
    day_of_week: row.day_of_week,
    week_number: row.week_number,
    sort_order: row.sort_order,
    exercises,
  };
}

export function toPlanExercise(
  row: PlanExerciseRow,
  sets: PlanSetResponse[] = [],
): PlanExerciseResponse {
  return {
    id: row.id,
    plan_day_id: row.plan_day_id,
    exercise_id: row.exercise_id,
    is_main_lift: row.is_main_lift,
    sort_order: row.sort_order,
    notes: row.notes,
    sets,
  };
}

export function toPlanSet(row: PlanSetRow): PlanSetResponse {
  return {
    id: row.id,
    plan_exercise_id: row.plan_exercise_id,
    set_number: row.set_number,
    target_reps: row.target_reps,
    target_reps_max: row.target_reps_max,
    intensity_mode: row.intensity_mode,
    target_value: row.target_value,
    set_type: row.set_type,
    created_at: timestamp(row.created_at),
  };
}

export function toExercise(row: ExerciseRow): ExerciseResponse {
  return {
    id: row.id,
    name: row.name,
    exercise_type: row.exercise_type,
    main_lift_family: row.main_lift_family,
    is_competition_lift: row.is_competition_lift,
    muscle_groups: row.muscle_groups,
    equipment: row.equipment,
    movement_pattern: row.movement_pattern,
    created_by_coach_id: row.created_by_coach_id,
    created_at: timestamp(row.created_at),
  };
}
