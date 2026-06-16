import { describe, expect, it } from 'vitest';

import {
  createBaseUsers,
  createPlanSchema,
  makeMigrationDb,
  runMigration,
} from '../helpers/migrations';

describe('migration 0017 set log failed', () => {
  it('adds failed with a false default for existing and new set logs', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    createPlanSchema(mem);
    runMigration(mem, 'db/migrations/0005-init-set-logs.sql');

    mem.public.none(`
      INSERT INTO set_logs (
        student_id, plan_exercise_id, set_index, weight_kg, reps, completed
      ) VALUES (
        '10000000-0000-4000-8000-000000000003',
        '50000000-0000-4000-8000-000000000001',
        1,
        100.00,
        5,
        TRUE
      );
    `);

    runMigration(mem, 'db/migrations/0017-add-failed-to-set-logs.sql');

    mem.public.none(`
      INSERT INTO set_logs (
        student_id, plan_exercise_id, set_index, weight_kg, reps, completed, failed
      ) VALUES (
        '10000000-0000-4000-8000-000000000003',
        '50000000-0000-4000-8000-000000000001',
        2,
        105.00,
        3,
        TRUE,
        TRUE
      );
    `);

    const rows = mem.public.many(`
      SELECT set_index, failed FROM set_logs ORDER BY set_index;
    `);
    expect(rows).toEqual([
      { set_index: 1, failed: false },
      { set_index: 2, failed: true },
    ]);
  });
});
