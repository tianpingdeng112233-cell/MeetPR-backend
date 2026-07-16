import fs from 'node:fs';

import { DataType } from 'pg-mem';
import { describe, expect, it } from 'vitest';

import { normalizeDateOnly } from '../../src/utils/date';
import { createBaseUsers, makeMigrationDb, runMigration } from '../helpers/migrations';

const COACH = '10000000-0000-4000-8000-000000000001';
const STUDENT = '10000000-0000-4000-8000-000000000003';
const PLAN_DAY = '40000000-0000-4000-8000-000000000001';
const PLAN_EXERCISE = '50000000-0000-4000-8000-000000000001';
const PLAN_EXERCISE_2 = '50000000-0000-4000-8000-000000000002';

function setup() {
  const mem = makeMigrationDb();
  // PostgreSQL has replace(text, text, text); pg-mem does not ship it.
  mem.public.registerFunction({
    name: 'replace',
    args: [DataType.text, DataType.text, DataType.text],
    returns: DataType.text,
    implementation: (value: string, from: string, to: string) => value.split(from).join(to),
  });
  createBaseUsers(mem);
  mem.public.none(`
    CREATE TABLE plan_days (
      id UUID PRIMARY KEY
    );
    CREATE TABLE plan_exercises (
      id UUID PRIMARY KEY,
      plan_day_id UUID NOT NULL REFERENCES plan_days(id) ON DELETE CASCADE
    );
    CREATE TABLE plan_sets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_exercise_id UUID NOT NULL REFERENCES plan_exercises(id) ON DELETE CASCADE,
      set_number INT NOT NULL
    );
    CREATE TABLE set_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_exercise_id UUID REFERENCES plan_exercises(id),
      set_index INT NOT NULL,
      logged_date DATE NOT NULL,
      logged_at TIMESTAMPTZ NOT NULL,
      completed BOOLEAN NOT NULL DEFAULT FALSE,
      failed BOOLEAN NOT NULL DEFAULT FALSE,
      assumed BOOLEAN NOT NULL DEFAULT FALSE
    );

    INSERT INTO plan_days (id) VALUES ('${PLAN_DAY}');
    INSERT INTO plan_exercises (id, plan_day_id) VALUES
      ('${PLAN_EXERCISE}', '${PLAN_DAY}'),
      ('${PLAN_EXERCISE_2}', '${PLAN_DAY}');
    INSERT INTO plan_sets (plan_exercise_id, set_number) VALUES
      ('${PLAN_EXERCISE}', 1),
      ('${PLAN_EXERCISE}', 2),
      ('${PLAN_EXERCISE_2}', 1);

    INSERT INTO set_logs (
      student_id, plan_exercise_id, set_index, logged_date, logged_at, completed, failed, assumed
    ) VALUES
      -- All prescribed sets submitted across both exercises: completed. set_index is
      -- 0-based (production import path) while plan_sets.set_number is 1-based — the
      -- backfill must match by per-exercise counts, never by index equality.
      ('${STUDENT}', '${PLAN_EXERCISE}', 0, '2026-07-10', '2026-07-09T21:00:00Z', TRUE, FALSE, FALSE),
      ('${STUDENT}', '${PLAN_EXERCISE}', 1, '2026-07-10', '2026-07-10T02:00:00Z', FALSE, TRUE, FALSE),
      ('${STUDENT}', '${PLAN_EXERCISE_2}', 0, '2026-07-10', '2026-07-10T01:00:00Z', TRUE, FALSE, FALSE),
      -- The second set is assumed history and must neither complete nor time the
      -- session; exercise 2 is untouched, which alone also keeps the day partial.
      ('${STUDENT}', '${PLAN_EXERCISE}', 0, '2026-07-11', '2026-07-10T21:30:00Z', TRUE, FALSE, FALSE),
      ('${STUDENT}', '${PLAN_EXERCISE}', 1, '2026-07-11', '2026-07-10T22:00:00Z', TRUE, FALSE, TRUE),
      -- Pure adhoc sessions have no partial meaning and backfill as completed.
      ('${STUDENT}', NULL, 0, '2026-07-12', '2026-07-11T23:00:00Z', TRUE, FALSE, FALSE),
      -- Assumed-only history is excluded entirely.
      ('${STUDENT}', NULL, 0, '2026-07-13', '2026-07-12T23:00:00Z', TRUE, FALSE, TRUE),
      -- A mismatched logged_at lies outside this logged_date's 04:00 gym-day window.
      ('${STUDENT}', NULL, 0, '2026-07-14', '2026-07-14T21:00:00Z', TRUE, FALSE, FALSE);
  `);
  runMigration(mem, 'db/migrations/0041-init-activity-ledger.sql');
  return mem;
}

function migrationSql(): string {
  return fs.readFileSync('db/migrations/0041-init-activity-ledger.sql', 'utf8');
}

function backfillSql(): string {
  const sql = migrationSql();
  const start = sql.indexOf('-- Backfill start.');
  const end = sql.indexOf('-- Backfill end.');
  if (start < 0 || end < 0) throw new Error('0041 backfill markers missing');
  return sql.slice(start, end);
}

describe('migration 0041 student activity ledger', () => {
  it('declares all checks, unique constraints, indexes, and the open-signal partial unique index', () => {
    const sql = migrationSql();

    expect(sql).toContain("status IN ('in_progress', 'completed', 'partial')");
    expect(sql).toContain("event_type IN ('session_completed', 'session_partial', 'pr_e1rm')");
    expect(sql).toContain("signal_type IN ('missed_training', 'pr_congrats')");
    expect(sql).toContain("severity IN ('red', 'yellow', 'green')");
    expect(sql).toContain("status IN ('open', 'acked', 'auto_resolved', 'expired')");
    expect(sql).toContain('UNIQUE (student_id, session_date)');
    expect(sql).toContain('UNIQUE (dedup_key)');
    expect(sql).toContain('training_sessions_student_date_idx');
    expect(sql).toContain('student_events_coach_date_idx');
    expect(sql).toContain('student_events_student_occurred_idx');
    expect(sql).toContain('student_signals_coach_status_opened_idx');
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX student_signals_open_unique_idx[\s\S]*WHERE status = 'open'/,
    );
  });

  it('enforces checks, ordinary uniqueness, and open-signal partial uniqueness', () => {
    const mem = setup();

    expect(() => {
      mem.public.none(`UPDATE training_sessions SET status = 'stale';`);
    }).toThrow(/check constraint/i);
    expect(() => {
      mem.public.none(`
        INSERT INTO training_sessions (
          student_id, session_date, status, started_at, last_set_at
        ) VALUES (
          '${STUDENT}', '2026-07-10', 'completed', now(), now()
        );
      `);
    }).toThrow(/duplicate key|unique/i);

    mem.public.none(`
      INSERT INTO student_events (
        student_id, coach_id, event_type, session_date, occurred_at, dedup_key
      ) VALUES (
        '${STUDENT}', '${COACH}', 'session_completed', '2026-07-10', now(), 'session:${STUDENT}:2026-07-10'
      );
    `);
    expect(() => {
      mem.public.none(`
        INSERT INTO student_events (
          student_id, event_type, session_date, occurred_at, dedup_key
        ) VALUES (
          '${STUDENT}', 'session_partial', '2026-07-10', now(), 'session:${STUDENT}:2026-07-10'
        );
      `);
    }).toThrow(/duplicate key|unique/i);
    expect(() => {
      mem.public.none(`UPDATE student_events SET event_type = 'missed_training';`);
    }).toThrow(/check constraint/i);

    mem.public.none(`
      INSERT INTO student_signals (
        student_id, coach_id, signal_type, severity, status, reason, opened_at
      ) VALUES
        ('${STUDENT}', '${COACH}', 'missed_training', 'red', 'open', 'three missed days', now()),
        ('${STUDENT}', '${COACH}', 'missed_training', 'red', 'acked', 'older signal', now());
    `);
    expect(() => {
      mem.public.none(`
        INSERT INTO student_signals (
          student_id, coach_id, signal_type, severity, status, reason, opened_at
        ) VALUES (
          '${STUDENT}', '${COACH}', 'missed_training', 'red', 'open', 'duplicate open', now()
        );
      `);
    }).toThrow(/duplicate key|unique/i);
    expect(() => {
      mem.public.none(`UPDATE student_signals SET severity = 'blue';`);
    }).toThrow(/check constraint/i);
  });

  it('backfills completed, partial, and adhoc sessions while excluding assumed and out-of-window rows', () => {
    const mem = setup();
    const rows = mem.public.many(`
      SELECT session_date, status, started_at, last_set_at, completed_at, plan_day_ids
      FROM training_sessions
      ORDER BY session_date;
    `);

    expect(rows).toHaveLength(3);
    expect(
      rows.map((row) => ({
        session_date: normalizeDateOnly(row.session_date as string | Date),
        status: row.status,
        started_at: (row.started_at as Date).toISOString(),
        last_set_at: (row.last_set_at as Date).toISOString(),
        completed_at: row.completed_at === null ? null : (row.completed_at as Date).toISOString(),
        plan_day_ids: row.plan_day_ids,
      })),
    ).toEqual([
      {
        session_date: '2026-07-10',
        status: 'completed',
        started_at: '2026-07-09T21:00:00.000Z',
        last_set_at: '2026-07-10T02:00:00.000Z',
        completed_at: '2026-07-10T02:00:00.000Z',
        plan_day_ids: [PLAN_DAY],
      },
      {
        session_date: '2026-07-11',
        status: 'partial',
        started_at: '2026-07-10T21:30:00.000Z',
        last_set_at: '2026-07-10T21:30:00.000Z',
        completed_at: null,
        plan_day_ids: [PLAN_DAY],
      },
      {
        session_date: '2026-07-12',
        status: 'completed',
        started_at: '2026-07-11T23:00:00.000Z',
        last_set_at: '2026-07-11T23:00:00.000Z',
        completed_at: '2026-07-11T23:00:00.000Z',
        plan_day_ids: [],
      },
    ]);
  });

  it('replays the INSERT...SELECT backfill idempotently', () => {
    const mem = setup();
    const before = mem.public.one(`SELECT COUNT(*)::int AS count FROM training_sessions;`);

    mem.public.none(backfillSql());

    const after = mem.public.one(`SELECT COUNT(*)::int AS count FROM training_sessions;`);
    expect(after.count).toBe(before.count);
    expect(migrationSql()).toContain('ON CONFLICT (student_id, session_date) DO NOTHING');
  });
});
