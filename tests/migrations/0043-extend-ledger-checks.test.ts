import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import { makeMigrationDb, runMigration } from '../helpers/migrations';

const STUDENT = '10000000-0000-4000-8000-000000000003';
const COACH = '10000000-0000-4000-8000-000000000001';

function setup() {
  const mem = makeMigrationDb();
  mem.public.none(`
    CREATE TABLE users (id UUID PRIMARY KEY);
    INSERT INTO users (id) VALUES ('${COACH}'), ('${STUDENT}');

    -- pg-mem does not synthesize PostgreSQL's names for anonymous CHECKs,
    -- so name the pre-0043 constraints exactly as PostgreSQL named 0041's.
    CREATE TABLE student_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID NOT NULL REFERENCES users(id),
      event_type TEXT NOT NULL,
      CONSTRAINT student_events_event_type_check CHECK (
        event_type IN ('session_completed', 'session_partial', 'pr_e1rm')
      )
    );
    CREATE TABLE student_signals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID NOT NULL REFERENCES users(id),
      coach_id UUID NOT NULL REFERENCES users(id),
      signal_type TEXT NOT NULL,
      CONSTRAINT student_signals_signal_type_check CHECK (
        signal_type IN ('missed_training', 'pr_congrats')
      )
    );
  `);
  runMigration(mem, 'db/migrations/0043-extend-ledger-checks.sql');
  return mem;
}

describe('migration 0043 activity-ledger CHECK extensions', () => {
  it('drops PostgreSQL 0041 names and re-adds explicit stable names', () => {
    const sql = fs.readFileSync('db/migrations/0043-extend-ledger-checks.sql', 'utf8');

    expect(sql).toMatch(/DROP CONSTRAINT student_events_event_type_check/);
    expect(sql).toMatch(/ADD CONSTRAINT student_events_event_type_check CHECK/);
    expect(sql).toMatch(/DROP CONSTRAINT student_signals_signal_type_check/);
    expect(sql).toMatch(/ADD CONSTRAINT student_signals_signal_type_check CHECK/);
  });

  it('accepts every legacy and new value while continuing to reject invalid values', () => {
    const mem = setup();
    const eventTypes = ['session_completed', 'session_partial', 'pr_e1rm', 'set_failed'];
    const signalTypes = ['missed_training', 'pr_congrats', 'weight_failed'];

    for (const eventType of eventTypes) {
      mem.public.none(`
        INSERT INTO student_events (student_id, event_type)
        VALUES ('${STUDENT}', '${eventType}');
      `);
    }
    for (const signalType of signalTypes) {
      mem.public.none(`
        INSERT INTO student_signals (student_id, coach_id, signal_type)
        VALUES ('${STUDENT}', '${COACH}', '${signalType}');
      `);
    }

    expect(mem.public.one(`SELECT COUNT(*)::int AS count FROM student_events`).count).toBe(4);
    expect(mem.public.one(`SELECT COUNT(*)::int AS count FROM student_signals`).count).toBe(3);
    expect(() => {
      mem.public.none(`
        INSERT INTO student_events (student_id, event_type)
        VALUES ('${STUDENT}', 'not_an_event');
      `);
    }).toThrow(/check constraint/i);
    expect(() => {
      mem.public.none(`
        INSERT INTO student_signals (student_id, coach_id, signal_type)
        VALUES ('${STUDENT}', '${COACH}', 'not_a_signal');
      `);
    }).toThrow(/check constraint/i);
  });
});
