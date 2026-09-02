import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

import { createBaseUsers, createPlanSchema, makeMigrationDb } from '../helpers/migrations';

const COACH = '10000000-0000-4000-8000-000000000001';
const STUDENT = '10000000-0000-4000-8000-000000000003';
const PLAN = '30000000-0000-4000-8000-000000000001';
const DAY_ONE = '40000000-0000-4000-8000-000000000001';
const DAY_TWO = '40000000-0000-4000-8000-000000000002';
const BATCH_ONE = '60000000-0000-4000-8000-000000000001';
const BATCH_TWO = '60000000-0000-4000-8000-000000000002';
const LEGACY_BATCH = '60000000-0000-4000-8000-000000000099';
const SHIFT_ONE = '70000000-0000-4000-8000-000000000001';
const SHIFT_TWO = '70000000-0000-4000-8000-000000000002';
const SHIFT_THREE = '70000000-0000-4000-8000-000000000003';
const SHIFT_FOUR = '70000000-0000-4000-8000-000000000004';

function runPlanShiftBatchMigration(mem: ReturnType<typeof makeMigrationDb>): void {
  const sql = fs.readFileSync('db/migrations/0070-plan-shift-batches.sql', 'utf8');
  const correlatedBackfill = /UPDATE plan_day_shifts AS s[\s\S]*?\n\);/;
  const pgSetval =
    /SELECT setval\(pg_get_serial_sequence\('plan_day_shifts', 'seq'\), max\(seq\)\)\s+FROM plan_day_shifts;/;
  const orderedIds = mem.public.many(`
    SELECT id::text
    FROM plan_day_shifts
    ORDER BY created_at, id;
  `) as { id: string }[];
  const pgMemBackfill = orderedIds
    .map(
      (row, index) =>
        `UPDATE plan_day_shifts SET seq = ${String(index + 1)} WHERE id = '${row.id}';`,
    )
    .join('\n');
  // pg-mem also skips the sequence default when BIGSERIAL NOT NULL is added
  // to a populated table and cannot correlate the UPDATE target into a scalar
  // subquery. Defer NOT NULL and apply the same ordering as the production SQL.
  mem.public.none(
    sql
      .replace(
        'ALTER TABLE plan_day_shifts\n  ADD COLUMN seq BIGSERIAL NOT NULL;',
        `CREATE SEQUENCE plan_day_shifts_seq_seq;
ALTER TABLE plan_day_shifts
  ADD COLUMN seq BIGINT DEFAULT nextval('plan_day_shifts_seq_seq');`,
      )
      .replace(correlatedBackfill, pgMemBackfill)
      .replace(pgSetval, 'ALTER TABLE plan_day_shifts ALTER COLUMN seq SET NOT NULL;'),
  );

  const maximum = Number(mem.public.one('SELECT max(seq) AS value FROM plan_day_shifts;').value);
  // Real PostgreSQL uses the removed setval(pg_get_serial_sequence(...), max(seq))
  // statement. pg-mem implements the equivalent through an explicit restart.
  mem.public.none(`ALTER SEQUENCE plan_day_shifts_seq_seq RESTART WITH ${String(maximum + 1)};`);
}

function setup() {
  const mem = makeMigrationDb();
  createBaseUsers(mem);
  createPlanSchema(mem);
  mem.public.none(`
    CREATE TABLE plan_day_shifts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_day_id UUID NOT NULL REFERENCES plan_days(id) ON DELETE CASCADE,
      student_id UUID NOT NULL REFERENCES users(id),
      batch_id UUID NOT NULL,
      shifted_to_date DATE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (plan_day_id, batch_id)
    );

    INSERT INTO plan_days (id, plan_id, day_of_week, week_number, sort_order)
    VALUES ('${DAY_TWO}', '${PLAN}', 3, 1, 1);

    INSERT INTO plan_day_shifts (
      id, plan_day_id, student_id, batch_id, shifted_to_date, created_at
    ) VALUES
      ('${SHIFT_FOUR}', '${DAY_TWO}', '${STUDENT}', '${BATCH_TWO}', DATE '2026-05-05', '2026-05-02T01:00:01Z'),
      ('${SHIFT_TWO}', '${DAY_TWO}', '${STUDENT}', '${BATCH_ONE}', DATE '2026-05-04', '2026-05-01T01:00:00Z'),
      ('${SHIFT_THREE}', '${DAY_ONE}', '${STUDENT}', '${BATCH_TWO}', DATE '2026-05-03', '2026-05-02T01:00:00Z'),
      ('${SHIFT_ONE}', '${DAY_ONE}', '${STUDENT}', '${BATCH_ONE}', DATE '2026-05-02', '2026-05-01T01:00:00Z');
  `);
  runPlanShiftBatchMigration(mem);
  return mem;
}

describe('migration 0070 plan shift batches', () => {
  it('creates batch metadata, enforces checks, and backfills each V2 batch', () => {
    const mem = setup();

    expect(
      mem.public.many(`
        SELECT id::text, plan_id::text, actor_id::text, actor_role,
               anchor_date, offset_days, created_at
        FROM plan_shift_batches
        ORDER BY id;
      `),
    ).toEqual([
      {
        id: BATCH_ONE,
        plan_id: PLAN,
        actor_id: STUDENT,
        actor_role: 'coached_student',
        anchor_date: new Date('2026-05-01T00:00:00.000Z'),
        offset_days: 1,
        created_at: new Date('2026-05-01T01:00:00.000Z'),
      },
      {
        id: BATCH_TWO,
        plan_id: PLAN,
        actor_id: STUDENT,
        actor_role: 'coached_student',
        anchor_date: new Date('2026-05-02T00:00:00.000Z'),
        offset_days: 1,
        created_at: new Date('2026-05-02T01:00:00.000Z'),
      },
    ]);

    expect(() => {
      mem.public.none(`
        INSERT INTO plan_shift_batches (
          id, plan_id, actor_id, actor_role, anchor_date, offset_days
        ) VALUES (
          '60000000-0000-4000-8000-000000000003', '${PLAN}', '${COACH}',
          'admin', DATE '2026-05-01', 1
        );
      `);
    }).toThrow(/check|constraint/i);
    expect(() => {
      mem.public.none(`
        INSERT INTO plan_shift_batches (
          id, plan_id, actor_id, actor_role, anchor_date, offset_days
        ) VALUES (
          '60000000-0000-4000-8000-000000000004', '${PLAN}', '${COACH}',
          'coach', DATE '2026-05-01', 31
        );
      `);
    }).toThrow(/check|constraint/i);
  });

  it('cascades batches from a deleted plan', () => {
    const mem = setup();

    mem.public.none(`DELETE FROM plans WHERE id = '${PLAN}';`);
    expect(mem.public.one('SELECT COUNT(*)::int AS count FROM plan_shift_batches;').count).toBe(0);
    expect(mem.public.one('SELECT COUNT(*)::int AS count FROM plan_day_shifts;').count).toBe(0);
  });

  it('keeps legacy writers compatible when they insert a day shift without batch metadata', () => {
    const mem = setup();

    mem.public.none(`
      INSERT INTO plan_day_shifts (
        plan_day_id, student_id, batch_id, shifted_to_date, created_at
      ) VALUES (
        '${DAY_ONE}', '${STUDENT}', '${LEGACY_BATCH}', DATE '2026-05-06',
        '2026-05-03T01:00:00Z'
      );
    `);

    expect(
      mem.public.one(`
        SELECT seq
        FROM plan_day_shifts
        WHERE batch_id = '${LEGACY_BATCH}';
      `).seq,
    ).toBeGreaterThan(4);
  });

  it('backfills seq by created_at and id regardless of insertion order', () => {
    const mem = setup();

    const rows = mem.public.many(`
      SELECT id::text, seq
      FROM plan_day_shifts
      ORDER BY seq;
    `) as { id: string; seq: number | string }[];

    expect(rows.map((row) => ({ id: row.id, seq: Number(row.seq) }))).toEqual([
      { id: SHIFT_ONE, seq: 1 },
      { id: SHIFT_TWO, seq: 2 },
      { id: SHIFT_THREE, seq: 3 },
      { id: SHIFT_FOUR, seq: 4 },
    ]);
  });
});
