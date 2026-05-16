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
  text: string;
  posted_at: string;
  read_at: string | null;
}

export function toFeedback(row: FeedbackRow): FeedbackResponse {
  return {
    id: row.id,
    coach_id: row.coach_id,
    student_id: row.student_id,
    day_date: dateOnly(row.day_date),
    plan_exercise_id: row.plan_exercise_id,
    text: row.text,
    posted_at: timestamp(row.posted_at),
    read_at: row.read_at ? timestamp(row.read_at) : null,
  };
}
