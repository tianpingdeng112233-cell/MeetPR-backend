import type { Selectable } from 'kysely';

import type { FeedbackTable } from '../db/types';
import { timestamp } from './serialization';

type FeedbackRow = Selectable<FeedbackTable>;

function dateOnly(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

export interface FeedbackResponse {
  id: string;
  coach_id: string;
  student_id: string;
  day_date: string | null;
  plan_exercise_id: string | null;
  video_id: string | null;
  text: string;
  posted_at: string;
  read_at: string | null;
}

export interface FeedbackVideoResponse {
  id: string;
  exercise_name: string | null;
  set_index: number | null;
  weight_kg: string | null;
  reps: number | null;
  logged_at: string | null;
}

export interface FeedbackWithVideoResponse extends FeedbackResponse {
  video: FeedbackVideoResponse | null;
}

export interface FeedbackVideoMetadataRow {
  video_attachment_id: string | null;
  video_exercise_name: string | null;
  video_set_index: number | null;
  video_weight_kg: string | null;
  video_reps: number | null;
  video_logged_at: Date | null;
}

export function toFeedback(row: FeedbackRow): FeedbackResponse {
  return {
    id: row.id,
    coach_id: row.coach_id,
    student_id: row.student_id,
    day_date: dateOnly(row.day_date),
    plan_exercise_id: row.plan_exercise_id,
    video_id: row.video_id,
    text: row.text,
    posted_at: timestamp(row.posted_at),
    read_at: row.read_at ? timestamp(row.read_at) : null,
  };
}

export function toFeedbackWithVideo(
  row: FeedbackRow & FeedbackVideoMetadataRow,
): FeedbackWithVideoResponse {
  return {
    ...toFeedback(row),
    video:
      row.video_attachment_id === null
        ? null
        : {
            id: row.video_attachment_id,
            exercise_name: row.video_exercise_name,
            set_index: row.video_set_index,
            weight_kg: row.video_weight_kg === null ? null : Number(row.video_weight_kg).toFixed(2),
            reps: row.video_reps,
            logged_at: row.video_logged_at === null ? null : timestamp(row.video_logged_at),
          },
  };
}
