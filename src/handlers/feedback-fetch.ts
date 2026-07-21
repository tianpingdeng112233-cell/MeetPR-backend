import type { Kysely } from 'kysely';

import type { Database } from '../db/types';
import { type FeedbackWithVideoResponse, toFeedbackWithVideo } from './feedback-serialization';

function feedbackWithVideoQuery(db: Kysely<Database>) {
  return db
    .selectFrom('feedback as f')
    .leftJoin('attachments as a', 'a.id', 'f.video_id')
    .leftJoin('set_logs as sl', 'sl.id', 'a.set_log_id')
    .leftJoin('exercises as e', 'e.id', 'sl.exercise_id')
    .selectAll('f')
    .select([
      'a.id as video_attachment_id',
      'e.name as video_exercise_name',
      'sl.set_index as video_set_index',
      'sl.weight_kg as video_weight_kg',
      'sl.reps as video_reps',
      'sl.logged_at as video_logged_at',
    ]);
}

export async function fetchOwnFeedback(
  db: Kysely<Database>,
  studentId: string,
): Promise<FeedbackWithVideoResponse[]> {
  const rows = await feedbackWithVideoQuery(db)
    .where('f.student_id', '=', studentId)
    .orderBy('f.posted_at', 'desc')
    .execute();

  return rows.map(toFeedbackWithVideo);
}

export async function fetchCoachFeedback(
  db: Kysely<Database>,
  coachId: string,
  studentId: string,
): Promise<FeedbackWithVideoResponse[]> {
  const rows = await feedbackWithVideoQuery(db)
    .where('f.student_id', '=', studentId)
    .where('f.coach_id', '=', coachId)
    .orderBy('f.posted_at', 'desc')
    .execute();

  return rows.map(toFeedbackWithVideo);
}
