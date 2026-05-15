import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { Database } from '../db/types';
import { type FeedbackResponse, toFeedback } from './feedback-serialization';

export interface FeedbackInput {
  student_id: string;
  day_date: string | null;
  plan_exercise_id: string | null;
  text: string;
}

export async function coachHasPublishedPlanForStudent(
  db: Kysely<Database>,
  coachId: string,
  studentId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('plans')
    .select(sql<number>`1`.as('exists'))
    .where('coach_id', '=', coachId)
    .where('trainee_id', '=', studentId)
    .where('status', '=', 'published')
    .limit(1)
    .executeTakeFirst();

  return row !== undefined;
}

export async function coachOwnsPublishedPlanExercise(
  db: Kysely<Database>,
  coachId: string,
  studentId: string,
  planExerciseId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('plan_exercises as pe')
    .innerJoin('plan_days as pd', 'pd.id', 'pe.plan_day_id')
    .innerJoin('plans as p', 'p.id', 'pd.plan_id')
    .select(sql<number>`1`.as('exists'))
    .where('pe.id', '=', planExerciseId)
    .where('p.coach_id', '=', coachId)
    .where('p.trainee_id', '=', studentId)
    .where('p.status', '=', 'published')
    .limit(1)
    .executeTakeFirst();

  return row !== undefined;
}

export async function createFeedback(
  db: Kysely<Database>,
  coachId: string,
  input: FeedbackInput,
): Promise<FeedbackResponse> {
  const row = await db
    .insertInto('feedback')
    .values({
      coach_id: coachId,
      student_id: input.student_id,
      day_date: input.day_date,
      plan_exercise_id: input.plan_exercise_id,
      text: input.text.trim(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  return toFeedback(row);
}
