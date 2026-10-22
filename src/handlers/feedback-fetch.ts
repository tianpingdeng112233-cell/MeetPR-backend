import type { PreferredLocale } from '../i18n/locale';
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
      'e.created_by_coach_id as video_exercise_owner',
      'e.name_en as video_exercise_name_en',
      'sl.set_index as video_set_index',
      'sl.weight_kg as video_weight_kg',
      'sl.reps as video_reps',
      'sl.rpe as video_rpe',
      'sl.logged_at as video_logged_at',
    ]);
}

export async function fetchOwnFeedback(
  db: Kysely<Database>,
  studentId: string,
  locale?: PreferredLocale,
): Promise<FeedbackWithVideoResponse[]> {
  const rows = await feedbackWithVideoQuery(db)
    .where('f.student_id', '=', studentId)
    .orderBy('f.posted_at', 'desc')
    .execute();

  return rows.map((row) => toFeedbackWithVideo(row, locale));
}

export async function fetchCoachFeedback(
  db: Kysely<Database>,
  coachId: string,
  studentId: string,
  locale?: PreferredLocale,
): Promise<FeedbackWithVideoResponse[]> {
  const rows = await feedbackWithVideoQuery(db)
    .where('f.student_id', '=', studentId)
    .where('f.coach_id', '=', coachId)
    .orderBy('f.posted_at', 'desc')
    .execute();

  return rows.map((row) => toFeedbackWithVideo(row, locale));
}
