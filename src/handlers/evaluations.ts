import type { Kysely, Selectable, Transaction } from 'kysely';
import { sql } from 'kysely';

import type { Database, EvaluationPeriodsTable } from '../db/types';
import { timestamp } from './serialization';

type DbExecutor = Kysely<Database> | Transaction<Database>;
export type EvaluationPeriodRow = Selectable<EvaluationPeriodsTable>;

export interface EvaluationPeriodResponse {
  id: string;
  student_id: string;
  coach_id: string;
  bind_request_id: string;
  started_at: string;
  expected_end_at: string;
  completed_at: string | null;
  completion_type: EvaluationPeriodRow['completion_type'];
  in_progress: boolean;
  overdue: boolean;
}

/**
 * Serialize with read-time derived flags: an evaluation past expected_end_at
 * stays in progress and is marked overdue — never auto-completed (spec 005 D7).
 */
export function toEvaluationPeriod(row: EvaluationPeriodRow): EvaluationPeriodResponse {
  const inProgress = row.completed_at === null;
  const overdue = inProgress && new Date(row.expected_end_at) < new Date();
  return {
    id: row.id,
    student_id: row.student_id,
    coach_id: row.coach_id,
    bind_request_id: row.bind_request_id,
    started_at: timestamp(row.started_at),
    expected_end_at: timestamp(row.expected_end_at),
    completed_at: row.completed_at === null ? null : timestamp(row.completed_at),
    completion_type: row.completion_type,
    in_progress: inProgress,
    overdue,
  };
}

/** Latest evaluation period for a (coach, student) pair, completed included. */
export async function fetchEvaluationForPair(
  db: DbExecutor,
  coachId: string,
  studentId: string,
): Promise<EvaluationPeriodResponse | null> {
  const row = await db
    .selectFrom('evaluation_periods')
    .selectAll()
    .where('coach_id', '=', coachId)
    .where('student_id', '=', studentId)
    .orderBy('started_at', 'desc')
    .limit(1)
    .executeTakeFirst();

  return row ? toEvaluationPeriod(row) : null;
}

/** Latest evaluation period for a student across coaches. */
export async function fetchEvaluationForStudent(
  db: DbExecutor,
  studentId: string,
): Promise<EvaluationPeriodResponse | null> {
  const row = await db
    .selectFrom('evaluation_periods')
    .selectAll()
    .where('student_id', '=', studentId)
    .orderBy('started_at', 'desc')
    .limit(1)
    .executeTakeFirst();

  return row ? toEvaluationPeriod(row) : null;
}

export type CompleteEvaluationResult =
  | { type: 'completed'; evaluationPeriod: EvaluationPeriodResponse }
  | { type: 'not-found' }
  | { type: 'already-completed' };

export async function completeEvaluation(
  db: Kysely<Database>,
  coachId: string,
  evaluationId: string,
): Promise<CompleteEvaluationResult> {
  return db.transaction().execute(async (trx): Promise<CompleteEvaluationResult> => {
    const existing = await trx
      .selectFrom('evaluation_periods')
      .select(['id', 'completed_at'])
      .where('id', '=', evaluationId)
      .where('coach_id', '=', coachId)
      .executeTakeFirst();

    if (!existing) return { type: 'not-found' };
    if (existing.completed_at !== null) return { type: 'already-completed' };

    const updated = await trx
      .updateTable('evaluation_periods')
      .set({ completed_at: sql<Date>`now()`, completion_type: 'coach_completed' })
      .where('id', '=', existing.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    return { type: 'completed', evaluationPeriod: toEvaluationPeriod(updated) };
  });
}

/**
 * Publish hard gate (spec 005 D9): true when the coach has an active
 * (uncompleted) evaluation period with the trainee.
 */
export async function hasActiveEvaluation(
  db: DbExecutor,
  coachId: string,
  studentId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('evaluation_periods')
    .select(sql<number>`1`.as('exists'))
    .where('coach_id', '=', coachId)
    .where('student_id', '=', studentId)
    .where('completed_at', 'is', null)
    .limit(1)
    .executeTakeFirst();

  return row !== undefined;
}
