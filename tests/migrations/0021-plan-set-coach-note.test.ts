import { describe, expect, it } from 'vitest';

import {
  createBaseUsers,
  createPlanSchema,
  makeMigrationDb,
  runMigration,
} from '../helpers/migrations';

const planExerciseId = '50000000-0000-4000-8000-000000000001';

describe('migration 0021 plan set coach note', () => {
  it('adds a nullable coach_note to existing and new plan sets', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    createPlanSchema(mem);
    mem.public.none(`
      CREATE TABLE plan_sets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        plan_exercise_id UUID NOT NULL REFERENCES plan_exercises(id) ON DELETE CASCADE,
        set_number SMALLINT NOT NULL,
        target_reps SMALLINT NOT NULL,
        target_reps_max SMALLINT,
        intensity_mode TEXT NOT NULL,
        target_value NUMERIC(6, 2) NOT NULL,
        set_type TEXT NOT NULL,
        rest_seconds INT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      INSERT INTO plan_sets (
        plan_exercise_id, set_number, target_reps, target_reps_max,
        intensity_mode, target_value, set_type
      ) VALUES (
        '${planExerciseId}', 1, 5, NULL, 'weight', 100.00, 'working'
      );
    `);

    runMigration(mem, 'db/migrations/0021-add-coach-note-to-plan-sets.sql');

    mem.public.none(`
      INSERT INTO plan_sets (
        plan_exercise_id, set_number, target_reps, target_reps_max,
        intensity_mode, target_value, set_type, coach_note
      ) VALUES (
        '${planExerciseId}', 2, 5, NULL, 'weight', 105.00, 'working', '70%top'
      );
    `);

    const rows = mem.public.many(`
      SELECT set_number, coach_note FROM plan_sets ORDER BY set_number;
    `);
    expect(rows).toEqual([
      { set_number: 1, coach_note: null },
      { set_number: 2, coach_note: '70%top' },
    ]);
  });
});
