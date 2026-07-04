import type { Kysely, Selectable } from 'kysely';

import type { Database, SetLogsTable } from '../db/types';
import { dateOnly, timestamp } from './serialization';

type SetLogRow = Selectable<SetLogsTable>;

export interface SetLogResponse {
  id: string;
  student_id: string;
  plan_exercise_id: string | null;
  exercise_id: string;
  set_index: number;
  weight_kg: string;
  reps: number;
  rpe: string | null;
  completed: boolean;
  failed: boolean;
  adhoc: boolean;
  logged_date: string;
  logged_at: string;
}

export function toSetLog(row: SetLogRow): SetLogResponse {
  return {
    id: row.id,
    student_id: row.student_id,
    plan_exercise_id: row.plan_exercise_id,
    exercise_id: row.exercise_id,
    set_index: row.set_index,
    weight_kg: Number(row.weight_kg).toFixed(2),
    reps: row.reps,
    rpe: row.rpe == null ? null : Number(row.rpe).toFixed(1),
    completed: row.completed,
    failed: row.failed,
    adhoc: row.adhoc,
    logged_date: dateOnly(row.logged_date),
    logged_at: timestamp(row.logged_at),
  };
}

export type SetLogScope = 'plan' | 'all';

export async function fetchOwnSetLogs(
  db: Kysely<Database>,
  studentId: string,
  from: string,
  to: string,
  scope: SetLogScope,
): Promise<SetLogResponse[]> {
  const base = db.selectFrom('set_logs').selectAll().where('student_id', '=', studentId);

  // scope=plan reproduces the pre-0031 visible set byte-for-byte: plan-linked
  // rows only, windowed on logged_at. Deployed builds decode plan_exercise_id
  // as a non-optional UUID, so null rows (adhoc/orphaned) must stay out of
  // their responses. scope=all is the training-day view for spec-045 clients:
  // every row, windowed on the client-local logged_date so sets flushed from
  // an offline queue land on the day they were performed.
  const rows =
    scope === 'plan'
      ? await base
          .where('plan_exercise_id', 'is not', null)
          .where('logged_at', '>=', new Date(`${from}T00:00:00.000Z`))
          .where('logged_at', '<', new Date(`${to}T00:00:00.000Z`))
          .orderBy('logged_at', 'desc')
          .execute()
      : await base
          .where('logged_date', '>=', from)
          .where('logged_date', '<', to)
          .orderBy('logged_date', 'desc')
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
      'sl.exercise_id as exercise_id',
      'sl.set_index as set_index',
      'sl.weight_kg as weight_kg',
      'sl.reps as reps',
      'sl.rpe as rpe',
      'sl.completed as completed',
      'sl.failed as failed',
      'sl.adhoc as adhoc',
      'sl.logged_date as logged_date',
      'sl.logged_at as logged_at',
    ])
    .where('sl.student_id', '=', studentId)
    .where('p.coach_id', '=', coachId)
    .where('p.trainee_id', '=', studentId)
    .where('p.status', '=', 'published')
    .where('sl.logged_at', '>=', from)
    .where('sl.logged_at', '<', to)
    .orderBy('sl.logged_at', 'desc')
    .execute();

  return rows.map(toSetLog);
}
