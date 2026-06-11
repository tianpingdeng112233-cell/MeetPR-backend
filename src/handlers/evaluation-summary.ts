import type { Kysely, Selectable, Transaction } from 'kysely';
import { sql } from 'kysely';

import type { Database, StudentEvaluationsTable } from '../db/types';
import { timestamp } from './serialization';

type DbExecutor = Kysely<Database> | Transaction<Database>;
type StudentEvaluationRow = Selectable<StudentEvaluationsTable>;

export interface EvaluationSummaryResponse {
  id: string;
  student_id: string;
  coach_id: string;
  evaluation_period_id: string | null;
  overall_assessment: string;
  training_plan: string;
  words_to_student: string | null;
  first_saved_at: string;
  last_updated_at: string;
  is_active: boolean;
}

export interface UpsertEvaluationSummaryInput {
  overall_assessment: string;
  training_plan: string;
  words_to_student: string | null;
  notify_student: boolean;
}

function toEvaluationSummary(row: StudentEvaluationRow): EvaluationSummaryResponse {
  return {
    id: row.id,
    student_id: row.student_id,
    coach_id: row.coach_id,
    evaluation_period_id: row.evaluation_period_id,
    overall_assessment: row.overall_assessment,
    training_plan: row.training_plan,
    words_to_student: row.words_to_student,
    first_saved_at: timestamp(row.first_saved_at),
    last_updated_at: timestamp(row.last_updated_at),
    is_active: row.is_active,
  };
}

/**
 * Upsert the active summary for (student, coach) and append a version snapshot.
 * first_saved_at and evaluation_period_id are set on first insert only;
 * notify_student is recorded on the version row — the backend only books the
 * fact, push semantics live on iOS (spec 005 D10).
 */
export async function upsertEvaluationSummary(
  db: Kysely<Database>,
  coachId: string,
  studentId: string,
  input: UpsertEvaluationSummaryInput,
): Promise<EvaluationSummaryResponse> {
  return db.transaction().execute(async (trx) => {
    // Link the latest evaluation period at first save; NULL when the coach
    // skipped the evaluation (acquaintance path).
    const latestPeriod = await trx
      .selectFrom('evaluation_periods')
      .select(['id'])
      .where('coach_id', '=', coachId)
      .where('student_id', '=', studentId)
      .orderBy('started_at', 'desc')
      .limit(1)
      .executeTakeFirst();

    const row = await trx
      .insertInto('student_evaluations')
      .values({
        student_id: studentId,
        coach_id: coachId,
        evaluation_period_id: latestPeriod?.id ?? null,
        overall_assessment: input.overall_assessment,
        training_plan: input.training_plan,
        words_to_student: input.words_to_student,
      })
      .onConflict((oc) =>
        oc.columns(['student_id', 'coach_id']).doUpdateSet({
          overall_assessment: input.overall_assessment,
          training_plan: input.training_plan,
          words_to_student: input.words_to_student,
          last_updated_at: sql<Date>`now()`,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    await trx
      .insertInto('student_evaluation_versions')
      .values({
        evaluation_id: row.id,
        overall_assessment: input.overall_assessment,
        training_plan: input.training_plan,
        words_to_student: input.words_to_student,
        notified_student: input.notify_student,
      })
      .execute();

    return toEvaluationSummary(row);
  });
}

/** Coach view: only the summary this coach wrote (multi-coach leak guard). */
export async function fetchEvaluationSummaryForCoach(
  db: DbExecutor,
  coachId: string,
  studentId: string,
): Promise<EvaluationSummaryResponse | null> {
  const row = await db
    .selectFrom('student_evaluations')
    .selectAll()
    .where('coach_id', '=', coachId)
    .where('student_id', '=', studentId)
    .executeTakeFirst();

  return row ? toEvaluationSummary(row) : null;
}

/** Student view: latest active summary across coaches. */
export async function fetchEvaluationSummaryForStudent(
  db: DbExecutor,
  studentId: string,
): Promise<EvaluationSummaryResponse | null> {
  const row = await db
    .selectFrom('student_evaluations')
    .selectAll()
    .where('student_id', '=', studentId)
    .where('is_active', '=', true)
    .orderBy('last_updated_at', 'desc')
    .limit(1)
    .executeTakeFirst();

  return row ? toEvaluationSummary(row) : null;
}
