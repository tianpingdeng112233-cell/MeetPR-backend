import type { Kysely, Selectable } from 'kysely';

import type { Database, MuscleFatigueEntry, ReadinessCheckinsTable } from '../db/types';
import { dateOnly, timestamp } from './serialization';

type ReadinessCheckinRow = Selectable<ReadinessCheckinsTable>;

export interface ReadinessCheckinResponse {
  id: string;
  student_id: string;
  checkin_date: string;
  sleep_quality: number;
  mood: number;
  stress: number;
  muscle_fatigue: MuscleFatigueEntry[];
  submitted_at: string;
  updated_at: string;
}

/** Normalize JSONB: node-pg returns parsed JSON; pg-mem (tests) may return a string. */
function muscleFatigue(value: MuscleFatigueEntry[] | string): MuscleFatigueEntry[] {
  return typeof value === 'string' ? (JSON.parse(value) as MuscleFatigueEntry[]) : value;
}

export function toReadinessCheckin(row: ReadinessCheckinRow): ReadinessCheckinResponse {
  return {
    id: row.id,
    student_id: row.student_id,
    // checkin_date is NOT NULL; dateOnly only widens for the pg-mem Date case.
    checkin_date: dateOnly(row.checkin_date) ?? '',
    sleep_quality: row.sleep_quality,
    mood: row.mood,
    stress: row.stress,
    muscle_fatigue: muscleFatigue(row.muscle_fatigue),
    submitted_at: timestamp(row.submitted_at),
    updated_at: timestamp(row.updated_at),
  };
}

export async function fetchReadinessCheckin(
  db: Kysely<Database>,
  studentId: string,
  date: string,
): Promise<ReadinessCheckinResponse | null> {
  const row = await db
    .selectFrom('readiness_checkins')
    .selectAll()
    .where('student_id', '=', studentId)
    .where('checkin_date', '=', date)
    .executeTakeFirst();

  return row ? toReadinessCheckin(row) : null;
}
