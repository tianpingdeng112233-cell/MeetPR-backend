import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { Database, MuscleFatigueEntry } from '../db/types';
import { toReadinessCheckin, type ReadinessCheckinResponse } from './readiness-fetch';

export interface ReadinessCheckinInput {
  checkin_date: string;
  sleep_quality: number;
  mood: number;
  stress: number;
  // `| undefined` is required under exactOptionalPropertyTypes: the zod schema
  // makes energy optional, so the parsed body carries an explicit undefined.
  energy?: number | undefined;
  muscle_fatigue: MuscleFatigueEntry[];
}

/**
 * Upsert the student's check-in for the day. ON CONFLICT (student_id,
 * checkin_date) overwrites the submitted scales + muscle_fatigue and bumps
 * updated_at; submitted_at keeps the first-submission time. Callers return
 * 201 either way (aligned with POST /sets/log, spec 030 §C7).
 *
 * Returns the full check-in row: the iOS client decodes the POST response
 * as a complete ReadinessCheckinDTO (spec 030 §C7), so a partial body makes
 * every submit fail client-side after the row is written.
 */
export async function upsertReadinessCheckin(
  db: Kysely<Database>,
  studentId: string,
  input: ReadinessCheckinInput,
): Promise<ReadinessCheckinResponse> {
  const row = await db
    .insertInto('readiness_checkins')
    .values({
      student_id: studentId,
      checkin_date: input.checkin_date,
      sleep_quality: input.sleep_quality,
      mood: input.mood,
      stress: input.stress,
      energy: input.energy ?? null,
      muscle_fatigue: JSON.stringify(input.muscle_fatigue),
    })
    .onConflict((oc) =>
      oc.columns(['student_id', 'checkin_date']).doUpdateSet({
        sleep_quality: (eb) => eb.ref('excluded.sleep_quality'),
        mood: (eb) => eb.ref('excluded.mood'),
        stress: (eb) => eb.ref('excluded.stress'),
        energy: (eb) => eb.ref('excluded.energy'),
        muscle_fatigue: (eb) => eb.ref('excluded.muscle_fatigue'),
        updated_at: sql<Date>`now()`,
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();

  return toReadinessCheckin(row);
}
