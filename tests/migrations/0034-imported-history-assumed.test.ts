import { describe, expect, it } from 'vitest';

import {
  createBaseUsers,
  createPlanSchema,
  makeMigrationDb,
  runMigration,
} from '../helpers/migrations';

const PLAN = '30000000-0000-4000-8000-000000000001';
const PLAN_EXERCISE = '50000000-0000-4000-8000-000000000001';

function setup() {
  const mem = makeMigrationDb();
  createBaseUsers(mem);
  createPlanSchema(mem);
  mem.public.none(`
    CREATE TABLE set_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_exercise_id UUID,
      exercise_id UUID NOT NULL REFERENCES exercises(id),
      logged_date DATE NOT NULL,
      adhoc BOOLEAN NOT NULL DEFAULT FALSE,
      set_index INT NOT NULL,
      weight_kg NUMERIC(6,2) NOT NULL,
      reps INT NOT NULL,
      rpe NUMERIC(3,1),
      completed BOOLEAN NOT NULL DEFAULT FALSE,
      failed BOOLEAN NOT NULL DEFAULT FALSE,
      logged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT set_logs_plan_exercise_id_fkey
        FOREIGN KEY (plan_exercise_id) REFERENCES plan_exercises(id) ON DELETE SET NULL,
      UNIQUE (student_id, plan_exercise_id, set_index)
    );

    INSERT INTO set_logs (
      student_id, plan_exercise_id, exercise_id, logged_date,
      set_index, weight_kg, reps, completed
    ) VALUES (
      '10000000-0000-4000-8000-000000000003',
      '${PLAN_EXERCISE}',
      '20000000-0000-4000-8000-000000000001',
      '2026-05-01', 0, 100.00, 5, TRUE
    );
  `);
  runMigration(mem, 'db/migrations/0034-imported-history-assumed.sql');
  return mem;
}

describe('migration 0034 imported history assumed', () => {
  it('backfills assumed=false and enforces the non-null default', () => {
    const mem = setup();
    const existing = mem.public.one(`SELECT assumed FROM set_logs;`);
    expect(existing.assumed).toBe(false);

    expect(() => {
      mem.public.none(`UPDATE set_logs SET assumed = NULL;`);
    }).toThrow();
  });

  it('restricts plan deletion while linked history exists', () => {
    const mem = setup();

    expect(() => {
      mem.public.none(`DELETE FROM plans WHERE id = '${PLAN}';`);
    }).toThrow();
    const retained = mem.public.one(`SELECT plan_exercise_id FROM set_logs;`);
    expect(retained.plan_exercise_id).toBe(PLAN_EXERCISE);
  });
});
