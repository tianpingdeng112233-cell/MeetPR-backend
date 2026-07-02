import { describe, expect, it } from 'vitest';

import {
  createBaseUsers,
  createPlanSchema,
  makeMigrationDb,
  runMigration,
} from '../helpers/migrations';

const MIGRATION = 'db/migrations/0024-fix-single-leg-rdl-muscle-group.sql';

const TARGET_ID = '00000000-0000-0000-ca70-000000000108';
const BYSTANDER_ID = '00000000-0000-0000-ca70-000000000104';

interface ExerciseRow {
  id: string;
  name: string;
  name_en: string | null;
  muscle_groups: string[];
}

// The renamed row is seeded post-0023 (罗马尼亚硬拉 name) with the erroneous quad
// tag this migration corrects; 单腿硬拉 is seeded as a bystander that must not move.
function seedRows(mem: ReturnType<typeof makeMigrationDb>) {
  mem.public.none(
    `INSERT INTO exercises (id, name, name_en, exercise_type, main_lift_family, muscle_groups, equipment, movement_pattern)
     VALUES ('${TARGET_ID}', '单腿罗马尼亚硬拉', 'Single Leg RDL', 'accessory', NULL, ARRAY['quad']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY['hip_hinge']::TEXT[]),
            ('${BYSTANDER_ID}', '单腿硬拉', 'Single Leg Deadlift', 'accessory', NULL, ARRAY['hamstring']::TEXT[], ARRAY['dumbbell']::TEXT[], ARRAY['hip_hinge']::TEXT[]);`,
  );
}

describe('migration 0024 single-leg RDL muscle-group fix', () => {
  it('retags 单腿罗马尼亚硬拉 to hamstring without touching name or name_en', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    createPlanSchema(mem);
    seedRows(mem);
    runMigration(mem, MIGRATION);

    const rows = mem.public.many(
      `SELECT id, name, name_en, muscle_groups FROM exercises WHERE id = '${TARGET_ID}'`,
    ) as ExerciseRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.muscle_groups).toEqual(['hamstring']);
    expect(rows[0]?.name).toBe('单腿罗马尼亚硬拉');
    expect(rows[0]?.name_en).toBe('Single Leg RDL');
  });

  it('leaves the distinct 单腿硬拉 row untouched', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    createPlanSchema(mem);
    seedRows(mem);
    runMigration(mem, MIGRATION);

    const rows = mem.public.many(
      `SELECT id, name, muscle_groups FROM exercises WHERE id = '${BYSTANDER_ID}'`,
    ) as ExerciseRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('单腿硬拉');
    expect(rows[0]?.muscle_groups).toEqual(['hamstring']);
  });

  it('is idempotent on re-apply', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    createPlanSchema(mem);
    seedRows(mem);
    runMigration(mem, MIGRATION);
    runMigration(mem, MIGRATION);

    const rows = mem.public.many(
      `SELECT muscle_groups FROM exercises WHERE id = '${TARGET_ID}'`,
    ) as ExerciseRow[];
    expect(rows[0]?.muscle_groups).toEqual(['hamstring']);
  });
});
