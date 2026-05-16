import { describe, expect, it } from 'vitest';

import {
  createBaseUsers,
  createPlanSchema,
  makeMigrationDb,
  runMigration,
} from '../helpers/migrations';

describe('migration 0005 set logs', () => {
  it('enforces one log per student, plan exercise, and set index', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    createPlanSchema(mem);
    runMigration(mem, 'db/migrations/0005-init-set-logs.sql');

    mem.public.none(`
      INSERT INTO set_logs (
        student_id, plan_exercise_id, set_index, weight_kg, reps, rpe, completed
      ) VALUES (
        '10000000-0000-4000-8000-000000000003',
        '50000000-0000-4000-8000-000000000001',
        1,
        100.00,
        5,
        8.0,
        TRUE
      );
    `);

    expect(() => {
      mem.public.none(`
        INSERT INTO set_logs (
          student_id, plan_exercise_id, set_index, weight_kg, reps, completed
        ) VALUES (
          '10000000-0000-4000-8000-000000000003',
          '50000000-0000-4000-8000-000000000001',
          1,
          102.50,
          5,
          TRUE
        );
      `);
    }).toThrow();

    mem.public.none(`
      INSERT INTO set_logs (
        student_id, plan_exercise_id, set_index, weight_kg, reps, completed
      ) VALUES (
        '10000000-0000-4000-8000-000000000003',
        '50000000-0000-4000-8000-000000000001',
        1,
        102.50,
        6,
        TRUE
      )
      ON CONFLICT (student_id, plan_exercise_id, set_index)
      DO UPDATE SET weight_kg = EXCLUDED.weight_kg, reps = EXCLUDED.reps;
    `);

    const rows = mem.public.many('SELECT * FROM set_logs');
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.weight_kg)).toBe(102.5);
    expect(rows[0]?.reps).toBe(6);
  });
});
