import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  createBaseUsers,
  createPlanSchema,
  makeMigrationDb,
  runMigration,
} from '../helpers/migrations';

const studentId = '10000000-0000-4000-8000-000000000003';
const publishedPlanId = '30000000-0000-4000-8000-000000000001';
const publishedDayId = '40000000-0000-4000-8000-000000000001';

function setup() {
  const mem = makeMigrationDb();
  createBaseUsers(mem);
  createPlanSchema(mem);
  mem.public.none(`
    INSERT INTO plans (
      id, coach_id, trainee_id, name, start_date, end_date,
      plan_weeks, source, status, created_at, updated_at
    ) VALUES
    (
      '30000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000001',
      '${studentId}',
      'Draft Block',
      '2026-06-01',
      '2026-06-28',
      4,
      'coach',
      'draft',
      '2026-06-01T00:00:00Z',
      '2026-06-02T00:00:00Z'
    ),
    (
      '30000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000001',
      '${studentId}',
      'Completed Block',
      '2026-04-01',
      '2026-04-28',
      4,
      'coach',
      'completed',
      '2026-04-01T00:00:00Z',
      '2026-04-29T06:07:08Z'
    );
    UPDATE plans
    SET updated_at = '2026-05-02T03:04:05Z'
    WHERE id = '${publishedPlanId}';
  `);
  runMigration(mem, 'db/migrations/0057-sequence-progression.sql');
  return mem;
}

describe('migration 0057 sequence progression', () => {
  it('creates constrained completions with one row per day and cascade cleanup', () => {
    const mem = setup();

    mem.public.none(`
      INSERT INTO plan_day_completions (plan_day_id, student_id, source)
      VALUES ('${publishedDayId}', '${studentId}', 'manual');
    `);
    expect(mem.public.one(`SELECT source FROM plan_day_completions`)).toEqual({ source: 'manual' });
    expect(() => {
      mem.public.none(`
        INSERT INTO plan_day_completions (plan_day_id, student_id, source)
        VALUES ('${publishedDayId}', '${studentId}', 'auto');
      `);
    }).toThrow(/unique|duplicate/i);
    expect(() => {
      mem.public.none(`
        UPDATE plan_day_completions SET source = 'legacy' WHERE plan_day_id = '${publishedDayId}';
      `);
    }).toThrow(/check constraint|violates/i);

    mem.public.none(`DELETE FROM plan_days WHERE id = '${publishedDayId}'`);
    expect(mem.public.one(`SELECT count(*)::int AS count FROM plan_day_completions`).count).toBe(0);
  });

  it('backfills only published/completed plans from updated_at', () => {
    const mem = setup();
    const rows = mem.public.many(`
      SELECT status, published_at
      FROM plans
      ORDER BY status
    `) as { status: string; published_at: Date | null }[];

    expect(rows).toEqual([
      { status: 'completed', published_at: new Date('2026-04-29T06:07:08.000Z') },
      { status: 'draft', published_at: null },
      { status: 'published', published_at: new Date('2026-05-02T03:04:05.000Z') },
    ]);
  });

  it('is additive-only and pins the approved index/search path', () => {
    const sql = fs.readFileSync('db/migrations/0057-sequence-progression.sql', 'utf8');

    expect(sql).toMatch(/BEGIN;\s+SET search_path TO public;/);
    expect(sql).toMatch(
      /CREATE INDEX plan_day_completions_student_idx\s+ON plan_day_completions \(student_id, completed_at DESC\)/,
    );
    expect(sql).not.toMatch(/^\s*(?:DROP|TRUNCATE|DELETE)\s/imu);
  });
});
