import type { Selectable } from 'kysely';

import type {
  ExercisesTable,
  PlanDayCompletionsTable,
  PlanDayCompletionSource,
  PlanDayShiftsTable,
  PlanDaysTable,
  PlanExercisesTable,
  PlansTable,
  PlanSetsTable,
} from '../../db/types';
import { normalizeDateOnly } from '../../utils/date';

type TimestampValue = Date | string;

function timestamp(value: TimestampValue): string {
  return value instanceof Date ? value.toISOString() : value;
}

function nullableTimestamp(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return timestamp(value);
}

function nullableDecimal(value: string | number | null | undefined): string | null {
  if (value == null) return null;
  return Number(value).toFixed(2);
}

function nullableOneDecimal(value: string | number | null | undefined): string | null {
  if (value == null) return null;
  return Number(value).toFixed(1);
}

export type PlanRow = Selectable<PlansTable>;
export type PlanDayRow = Selectable<PlanDaysTable>;
export type PlanDayCompletionRow = Selectable<PlanDayCompletionsTable>;
export type PlanDayShiftRow = Selectable<PlanDayShiftsTable>;
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
  kind: PlanRow['kind'];
  block_type: PlanRow['block_type'];
  mesocycle_phase: PlanRow['mesocycle_phase'];
  training_max: string | null;
  tm_set_at: string | null;
  published_at: string | null;
  anchor_weekday: number | null;
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
  load_mode: PlanSetRow['load_mode'];
  pct_anchor: PlanSetRow['pct_anchor'];
  target_pct: string | null;
  target_rpe: string | null;
  rir_target: number | null;
  rpe_low: string | null;
  rpe_high: string | null;
  weight_low: string | null;
  weight_high: string | null;
  target_weight: string | null;
  set_type: PlanSetRow['set_type'];
  rest_seconds: number | null;
  coach_note: string | null;
  created_at: string;
}

export interface PlanExerciseResponse {
  id: string;
  plan_day_id: string;
  exercise_id: string;
  is_main_lift: boolean;
  sort_order: number;
  notes: string | null;
  target: string | null;
  has_logs: boolean;
  sets: PlanSetResponse[];
}

export interface PlanDayResponse {
  id: string;
  plan_id: string;
  day_of_week: number;
  week_number: number;
  sort_order: number;
  shifted_to_date: string | null;
  completed_at: string | null;
  completion_source: PlanDayCompletionSource | null;
  exercises: PlanExerciseResponse[];
}

export interface PlanDayCompletionResponse {
  id: string;
  plan_day_id: string;
  student_id: string;
  source: PlanDayCompletionSource;
  completed_at: string;
}

export interface PlanShiftSummaryResponse {
  total_shift_days: number;
  latest_shift_created_at: string | null;
}

export interface PlanWithChildrenResponse extends PlanResponse, PlanShiftSummaryResponse {
  days: PlanDayResponse[];
}

export interface ImportedHistoryResponse {
  plan_id: string;
  created_set_logs: number;
  existing_set_logs: number;
  assumed: true;
}

export interface ExerciseResponse {
  id: string;
  name: string;
  name_en: string | null;
  exercise_type: ExerciseRow['exercise_type'];
  main_lift_family: ExerciseRow['main_lift_family'];
  is_competition_lift: boolean;
  competition_stance: ExerciseRow['competition_stance'];
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
    kind: row.kind,
    block_type: row.block_type ?? null,
    mesocycle_phase: row.mesocycle_phase ?? null,
    training_max: nullableDecimal(row.training_max),
    tm_set_at: nullableTimestamp(row.tm_set_at),
    published_at: nullableTimestamp(row.published_at),
    anchor_weekday: row.anchor_weekday ?? null,
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at),
  };
}

export function toPlanDay(
  row: PlanDayRow,
  exercises: PlanExerciseResponse[] = [],
  shiftedToDate: string | Date | null = null,
  completedAt: Date | string | null = null,
  completionSource: PlanDayCompletionSource | null = null,
): PlanDayResponse {
  return {
    id: row.id,
    plan_id: row.plan_id,
    day_of_week: row.day_of_week,
    week_number: row.week_number,
    sort_order: row.sort_order,
    shifted_to_date: shiftedToDate === null ? null : normalizeDateOnly(shiftedToDate),
    completed_at: nullableTimestamp(completedAt),
    completion_source: completionSource,
    exercises,
  };
}

export function toPlanDayCompletion(row: PlanDayCompletionRow): PlanDayCompletionResponse {
  return {
    id: row.id,
    plan_day_id: row.plan_day_id,
    student_id: row.student_id,
    source: row.source,
    completed_at: timestamp(row.completed_at),
  };
}

export function toPlanShiftSummary(
  rows: Pick<PlanDayShiftRow, 'batch_id' | 'created_at'>[],
): PlanShiftSummaryResponse {
  const batchIds = new Set(rows.map((row) => row.batch_id));
  const latestCreatedAt = rows.reduce<Date | null>(
    (latest, row) => (latest === null || row.created_at > latest ? row.created_at : latest),
    null,
  );
  return {
    total_shift_days: batchIds.size,
    latest_shift_created_at: latestCreatedAt === null ? null : timestamp(latestCreatedAt),
  };
}

export function toPlanExercise(
  row: PlanExerciseRow,
  sets: PlanSetResponse[] = [],
  hasLogs = false,
): PlanExerciseResponse {
  return {
    id: row.id,
    plan_day_id: row.plan_day_id,
    exercise_id: row.exercise_id,
    is_main_lift: row.is_main_lift,
    sort_order: row.sort_order,
    notes: row.notes,
    target: row.target ?? null,
    has_logs: hasLogs,
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
    load_mode: row.load_mode,
    pct_anchor: row.pct_anchor,
    target_pct: nullableOneDecimal(row.target_pct),
    target_rpe: nullableOneDecimal(row.target_rpe),
    rir_target: row.rir_target,
    rpe_low: nullableOneDecimal(row.rpe_low),
    rpe_high: nullableOneDecimal(row.rpe_high),
    weight_low: nullableDecimal(row.weight_low),
    weight_high: nullableDecimal(row.weight_high),
    target_weight: nullableDecimal(
      row.target_weight ??
        (row.load_mode === null && row.intensity_mode === 'weight' ? row.target_value : null),
    ),
    set_type: row.set_type,
    rest_seconds: row.rest_seconds,
    coach_note: row.coach_note,
    created_at: timestamp(row.created_at),
  };
}

export function toImportedHistory(
  planId: string,
  createdSetLogs: number,
  existingSetLogs: number,
): ImportedHistoryResponse {
  return {
    plan_id: planId,
    created_set_logs: createdSetLogs,
    existing_set_logs: existingSetLogs,
    assumed: true,
  };
}

export function toExercise(row: ExerciseRow): ExerciseResponse {
  return {
    id: row.id,
    name: row.name,
    name_en: row.name_en,
    exercise_type: row.exercise_type,
    main_lift_family: row.main_lift_family,
    is_competition_lift: row.is_competition_lift,
    competition_stance: row.competition_stance ?? null,
    muscle_groups: row.muscle_groups,
    equipment: row.equipment,
    movement_pattern: row.movement_pattern,
    created_by_coach_id: row.created_by_coach_id,
    created_at: timestamp(row.created_at),
  };
}
