import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';

import type { Database, SessionReviewsTable } from '../db/types';
import { dateOnly, decimal, timestamp } from './serialization';

type SessionReviewRow = Selectable<SessionReviewsTable>;

export interface SessionReviewInput {
  review_date: string;
  feeling: string;
  session_rpe: string | null;
}

export interface SessionReviewResponse {
  id: string;
  student_id: string;
  review_date: string;
  feeling: string;
  session_rpe: string | null;
  updated_at: string;
}

export function toSessionReview(row: SessionReviewRow): SessionReviewResponse {
  return {
    id: row.id,
    student_id: row.student_id,
    review_date: dateOnly(row.review_date),
    feeling: row.feeling,
    session_rpe: decimal(row.session_rpe, 1),
    updated_at: timestamp(row.updated_at),
  };
}

export async function upsertSessionReview(
  db: Kysely<Database>,
  studentId: string,
  input: SessionReviewInput,
): Promise<SessionReviewResponse> {
  const row = await db
    .insertInto('session_reviews')
    .values({
      student_id: studentId,
      review_date: input.review_date,
      feeling: input.feeling,
      session_rpe: input.session_rpe,
    })
    .onConflict((oc) =>
      oc.columns(['student_id', 'review_date']).doUpdateSet({
        feeling: (eb) => eb.ref('excluded.feeling'),
        session_rpe: (eb) => eb.ref('excluded.session_rpe'),
        updated_at: sql<Date>`now()`,
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();

  return toSessionReview(row);
}

export async function fetchSessionReviews(
  db: Kysely<Database>,
  studentId: string,
  from: string,
  to: string,
): Promise<SessionReviewResponse[]> {
  const rows = await db
    .selectFrom('session_reviews')
    .selectAll()
    .where('student_id', '=', studentId)
    .where('review_date', '>=', from)
    .where('review_date', '<=', to)
    .orderBy('review_date', 'desc')
    .execute();

  return rows.map(toSessionReview);
}
