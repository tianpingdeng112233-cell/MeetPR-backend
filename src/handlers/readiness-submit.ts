import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { Database, MuscleFatigueEntry } from '../db/types';
import { timestamp } from './serialization';

export interface ReadinessCheckinInput {
  checkin_date: string;
  sleep_quality: number;
  mood: number;
  stress: number;
  muscle_fatigue: MuscleFatigueEntry[];
}

export interface ReadinessCheckinResult {
  id: string;
  submitted_at: string;
}

/**
 * Upsert the student's check-in for the day. ON CONFLICT (student_id,
 * checkin_date) overwrites the three scales + muscle_fatigue and bumps
 * updated_at; submitted_at keeps the first-submission time. Callers return
 * 201 either way (aligned with POST /sets/log, spec 030 §C7).
 */
export async function upsertReadinessCheckin(
  db: Kysely<Database>,
  studentId: string,
  input: ReadinessCheckinInput,
): Promise<ReadinessCheckinResult> {
  const row = await db
    .insertInto('readiness_checkins')
    .values({
      student_id: studentId,
      checkin_date: input.checkin_date,
      sleep_quality: input.sleep_quality,
      mood: input.mood,
      stress: input.stress,
      muscle_fatigue: JSON.stringify(input.muscle_fatigue),
    })
    .onConflict((oc) =>
      oc.columns(['student_id', 'checkin_date']).doUpdateSet({
        sleep_quality: (eb) => eb.ref('excluded.sleep_quality'),
        mood: (eb) => eb.ref('excluded.mood'),
        stress: (eb) => eb.ref('excluded.stress'),
        muscle_fatigue: (eb) => eb.ref('excluded.muscle_fatigue'),
        updated_at: sql<Date>`now()`,
      }),
    )
    .returning(['id', 'submitted_at'])
    .executeTakeFirstOrThrow();

  return {
    id: row.id,
    submitted_at: timestamp(row.submitted_at),
  };
}
