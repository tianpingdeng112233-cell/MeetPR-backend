import type { Kysely, Selectable } from 'kysely';

import type { Database, SetLogsTable } from '../db/types';
import { timestamp } from './serialization';

type SetLogRow = Selectable<SetLogsTable>;

export interface SetLogResponse {
  id: string;
  student_id: string;
  plan_exercise_id: string;
  set_index: number;
  weight_kg: string;
  reps: number;
  rpe: string | null;
  completed: boolean;
  failed: boolean;
  /** Present for imports; older clients may safely ignore this additive field. */
  assumed?: boolean;
  logged_at: string;
}

export function toSetLog(row: SetLogRow): SetLogResponse {
  return {
    id: row.id,
    student_id: row.student_id,
    plan_exercise_id: row.plan_exercise_id,
    set_index: row.set_index,
    weight_kg: Number(row.weight_kg).toFixed(2),
    reps: row.reps,
    rpe: row.rpe == null ? null : Number(row.rpe).toFixed(1),
    completed: row.completed,
    failed: row.failed,
    assumed: (row as { assumed?: boolean }).assumed ?? false,
    logged_at: timestamp(row.logged_at),
  };
}

export async function fetchOwnSetLogs(
  db: Kysely<Database>,
  studentId: string,
  from: Date,
  to: Date,
): Promise<SetLogResponse[]> {
  const rows = await db
    .selectFrom('set_logs')
    .selectAll()
    .where('student_id', '=', studentId)
    .where('logged_at', '>=', from)
    .where('logged_at', '<', to)
    .orderBy('logged_at', 'desc')
    .execute();

  return rows.map(toSetLog);
}

export async function fetchCoachSetLogs(
  db: Kysely<Database>,
  coachId: string,
  studentId: string,
  from: Date,
  to: Date,
): Promise<SetLogResponse[]> {
  const rows = await db
    .selectFrom('set_logs as sl')
    .innerJoin('plan_exercises as pe', 'pe.id', 'sl.plan_exercise_id')
    .innerJoin('plan_days as pd', 'pd.id', 'pe.plan_day_id')
    .innerJoin('plans as p', 'p.id', 'pd.plan_id')
    .select([
      'sl.id as id',
      'sl.student_id as student_id',
      'sl.plan_exercise_id as plan_exercise_id',
      'sl.set_index as set_index',
      'sl.weight_kg as weight_kg',
      'sl.reps as reps',
      'sl.rpe as rpe',
      'sl.completed as completed',
      'sl.failed as failed',
      'sl.assumed as assumed',
      'sl.logged_at as logged_at',
    ])
    .where('sl.student_id', '=', studentId)
    .where('p.coach_id', '=', coachId)
    .where('p.trainee_id', '=', studentId)
    .where('sl.logged_at', '>=', from)
    .where('sl.logged_at', '<', to)
    .orderBy('sl.logged_at', 'desc')
    .execute();

  return rows.map(toSetLog);
}
