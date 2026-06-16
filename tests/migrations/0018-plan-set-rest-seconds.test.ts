import { describe, expect, it } from 'vitest';

import {
  createBaseUsers,
  createPlanSchema,
  makeMigrationDb,
  runMigration,
} from '../helpers/migrations';

describe('migration 0018 plan set rest seconds', () => {
  it('adds nullable rest_seconds to existing and new plan sets', () => {
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
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      INSERT INTO plan_sets (
        plan_exercise_id, set_number, target_reps, target_reps_max,
        intensity_mode, target_value, set_type
      ) VALUES (
        '50000000-0000-4000-8000-000000000001',
        1,
        5,
        NULL,
        'weight',
        100.00,
        'working'
      );
    `);

    runMigration(mem, 'db/migrations/0018-add-rest-seconds-to-plan-sets.sql');

    mem.public.none(`
      INSERT INTO plan_sets (
        plan_exercise_id, set_number, target_reps, target_reps_max,
        intensity_mode, target_value, set_type
      ) VALUES (
        '50000000-0000-4000-8000-000000000001',
        2,
        5,
        NULL,
        'weight',
        105.00,
        'working'
      );

      INSERT INTO plan_sets (
        plan_exercise_id, set_number, target_reps, target_reps_max,
        intensity_mode, target_value, set_type, rest_seconds
      ) VALUES (
        '50000000-0000-4000-8000-000000000001',
        3,
        3,
        NULL,
        'weight',
        110.00,
        'working',
        180
      );
    `);

    const rows = mem.public.many(`
      SELECT set_number, rest_seconds FROM plan_sets ORDER BY set_number;
    `);
    expect(rows).toEqual([
      { set_number: 1, rest_seconds: null },
      { set_number: 2, rest_seconds: null },
      { set_number: 3, rest_seconds: 180 },
    ]);
  });
});
