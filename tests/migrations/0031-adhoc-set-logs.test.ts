import { describe, expect, it } from 'vitest';

import {
  createBaseUsers,
  createPlanSchema,
  makeMigrationDb,
  runMigration,
} from '../helpers/migrations';

const STUDENT = '10000000-0000-4000-8000-000000000003';
const EXERCISE = '20000000-0000-4000-8000-000000000001';
const PLAN = '30000000-0000-4000-8000-000000000001';
const PLAN_EXERCISE = '50000000-0000-4000-8000-000000000001';

/**
 * Base set_logs schema as of 0005+0017, hand-rolled with an explicitly named
 * plan FK: pg-mem does not register Postgres's default constraint name for
 * inline REFERENCES, so replaying the literal 0005 file would make 0031's
 * `DROP CONSTRAINT set_logs_plan_exercise_id_fkey` fail here even though it
 * is correct on real Postgres (verified against staging in spec 010 验收 #4).
 * Same precedent as createPlanSchema in tests/helpers/migrations.ts.
 */
function createSetLogsBase(mem: ReturnType<typeof makeMigrationDb>): void {
  mem.public.none(`
    CREATE TABLE set_logs (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_exercise_id UUID NOT NULL,
      set_index        INT NOT NULL CHECK (set_index >= 0),
      weight_kg        NUMERIC(6,2) NOT NULL CHECK (weight_kg >= 0 AND weight_kg <= 9999.99),
      reps             INT NOT NULL CHECK (reps >= 0 AND reps <= 99),
      rpe              NUMERIC(3,1) CHECK (rpe IS NULL OR (rpe >= 0 AND rpe <= 10.0)),
      completed        BOOLEAN NOT NULL DEFAULT FALSE,
      failed           BOOLEAN NOT NULL DEFAULT FALSE,
      logged_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT set_logs_plan_exercise_id_fkey
        FOREIGN KEY (plan_exercise_id) REFERENCES plan_exercises(id) ON DELETE CASCADE,
      UNIQUE (student_id, plan_exercise_id, set_index)
    );
  `);
}

function setup() {
  const mem = makeMigrationDb();
  createBaseUsers(mem);
  createPlanSchema(mem);
  createSetLogsBase(mem);
  mem.public.none(`
    INSERT INTO set_logs (
      student_id, plan_exercise_id, set_index, weight_kg, reps, completed, logged_at
    ) VALUES (
      '${STUDENT}', '${PLAN_EXERCISE}', 1, 100.00, 5, TRUE, '2026-07-03T20:30:00Z'
    );
  `);
  runMigration(mem, 'db/migrations/0031-adhoc-set-logs.sql');
  return mem;
}

function dateText(value: unknown): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
}

describe('migration 0031 adhoc set logs', () => {
  it('backfills exercise_id and Shanghai-local logged_date for existing rows', () => {
    const mem = setup();
    const rows = mem.public.many(`
      SELECT exercise_id, logged_date, adhoc, plan_exercise_id FROM set_logs;
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].exercise_id).toBe(EXERCISE);
    // 2026-07-03T20:30Z + 8h = 2026-07-04 in fixed-offset Asia/Shanghai.
    expect(dateText(rows[0].logged_date)).toBe('2026-07-04');
    expect(rows[0].adhoc).toBe(false);
    expect(rows[0].plan_exercise_id).toBe(PLAN_EXERCISE);
  });

  it('keeps set logs alive when their plan is deleted (SET NULL, not CASCADE)', () => {
    const mem = setup();
    mem.public.none(`DELETE FROM plans WHERE id = '${PLAN}';`);
    const rows = mem.public.many(`
      SELECT plan_exercise_id, exercise_id, adhoc FROM set_logs;
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].plan_exercise_id).toBeNull();
    expect(rows[0].exercise_id).toBe(EXERCISE);
    expect(rows[0].adhoc).toBe(false);
  });

  it('accepts adhoc rows without a plan and enforces adhoc uniqueness', () => {
    const mem = setup();
    mem.public.none(`
      INSERT INTO set_logs (
        student_id, exercise_id, logged_date, adhoc, set_index, weight_kg, reps, completed
      ) VALUES (
        '${STUDENT}', '${EXERCISE}', '2026-07-04', TRUE, 0, 140.00, 5, TRUE
      );
    `);
    expect(() => {
      mem.public.none(`
        INSERT INTO set_logs (
          student_id, exercise_id, logged_date, adhoc, set_index, weight_kg, reps, completed
        ) VALUES (
          '${STUDENT}', '${EXERCISE}', '2026-07-04', TRUE, 0, 145.00, 3, TRUE
        );
      `);
    }).toThrow();
  });

  it('rejects adhoc rows that still point at a plan exercise', () => {
    const mem = setup();
    expect(() => {
      mem.public.none(`
        INSERT INTO set_logs (
          student_id, plan_exercise_id, exercise_id, logged_date, adhoc,
          set_index, weight_kg, reps, completed
        ) VALUES (
          '${STUDENT}', '${PLAN_EXERCISE}', '${EXERCISE}', '2026-07-04', TRUE,
          2, 60.00, 8, TRUE
        );
      `);
    }).toThrow();
  });

  it('lets orphaned plan rows coexist with adhoc rows on the same tuple', () => {
    const mem = setup();
    mem.public.none(`DELETE FROM plans WHERE id = '${PLAN}';`);
    // Orphaned row occupies (student, exercise, 2026-07-04, set_index 1) with
    // adhoc = false; the partial unique index must not see it.
    mem.public.none(`
      INSERT INTO set_logs (
        student_id, exercise_id, logged_date, adhoc, set_index, weight_kg, reps, completed
      ) VALUES (
        '${STUDENT}', '${EXERCISE}', '2026-07-04', TRUE, 1, 150.00, 2, TRUE
      );
    `);
    const rows = mem.public.many(`SELECT adhoc FROM set_logs ORDER BY adhoc;`);
    expect(rows).toHaveLength(2);
  });
});
