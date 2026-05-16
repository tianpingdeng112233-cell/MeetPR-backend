import type { Kysely } from 'kysely';

import type { Database } from '../db/types';
import { type FeedbackResponse, toFeedback } from './feedback-serialization';

export async function fetchOwnFeedback(
  db: Kysely<Database>,
  studentId: string,
): Promise<FeedbackResponse[]> {
  const rows = await db
    .selectFrom('feedback')
    .selectAll()
    .where('student_id', '=', studentId)
    .orderBy('posted_at', 'desc')
    .execute();

  return rows.map(toFeedback);
}

export async function fetchCoachFeedback(
  db: Kysely<Database>,
  coachId: string,
  studentId: string,
): Promise<FeedbackResponse[]> {
  const rows = await db
    .selectFrom('feedback')
    .selectAll()
    .where('student_id', '=', studentId)
    .where('coach_id', '=', coachId)
    .orderBy('posted_at', 'desc')
    .execute();

  return rows.map(toFeedback);
}
