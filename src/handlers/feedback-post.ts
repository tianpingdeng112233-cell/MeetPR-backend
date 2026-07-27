import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { Database } from '../db/types';
import { type FeedbackResponse, toFeedback } from './feedback-serialization';
import { coachSetVideoProvenancePredicate } from './set-video-access';

export interface FeedbackInput {
  student_id: string;
  day_date: string | null;
  plan_exercise_id: string | null;
  video_id: string | null;
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

/**
 * True when this coach may attach the student's set video to a feedback item.
 *
 * The owner/kind/status triple is the obvious half. The provenance clause is
 * the half that matters for dual-coach students: it mirrors the visibility gate
 * in GET /students/:id/videos verbatim, so a video coach A can't *see* is also
 * a video coach A can't *link*. Without it, the feedback row becomes a side
 * channel that re-exposes coach B's uploads through the student's inbox.
 */
export async function coachMayAttachSetVideo(
  db: Kysely<Database>,
  coachId: string,
  studentId: string,
  videoId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('attachments')
    .select(sql<number>`1`.as('exists'))
    .where('id', '=', videoId)
    .where('owner_id', '=', studentId)
    .where('kind', '=', 'set_video')
    .where('status', '=', 'ready')
    .where(coachSetVideoProvenancePredicate(coachId))
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
      video_id: input.video_id,
      text: input.text.trim(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  return toFeedback(row);
}
