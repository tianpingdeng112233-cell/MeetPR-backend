import { describe, expect, it } from 'vitest';

import {
  createBaseUsers,
  createPlanSchema,
  makeMigrationDb,
  runMigration,
} from '../helpers/migrations';

const MIGRATION = 'db/migrations/0019-sync-plan-coverage-exercises.sql';

// The 15 exercises this migration adds (ids ca71-…0001..000f).
const NEW_IDS = Array.from(
  { length: 15 },
  (_, i) => `00000000-0000-0000-ca71-${(i + 1).toString(16).padStart(12, '0')}`,
);
const newIdList = NEW_IDS.map((id) => `'${id}'`).join(', ');

interface ExerciseRow {
  id: string;
  name: string;
  name_en: string | null;
  exercise_type: string;
  main_lift_family: string | null;
}

// The real catalog table is built by 0002 + the generated 0002.1, which pg-mem can't
// execute (array `<@` checks, DROP CONSTRAINT). createPlanSchema stands in with the
// same columns; full constraint compatibility against the 0002.1-rebuilt CHECKs is
// verified on real Postgres, not here.
describe('migration 0019 plan-coverage catalog sync', () => {
  it('inserts the fifteen new exercises with the expected metadata', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    createPlanSchema(mem);
    runMigration(mem, MIGRATION);

    const rows = mem.public.many(
      `SELECT id, name, name_en, exercise_type, main_lift_family
       FROM exercises WHERE id IN (${newIdList})`,
    ) as ExerciseRow[];
    expect(rows).toHaveLength(15);

    const lowBar = rows.find((r) => r.name_en === 'Low Bar Squat');
    expect(lowBar?.name).toBe('低杠位深蹲');
    expect(lowBar?.exercise_type).toBe('main_lift_variation');
    expect(lowBar?.main_lift_family).toBe('squat');

    const deficit = rows.find((r) => r.name_en === 'Deficit Sumo Deadlift');
    expect(deficit?.name).toBe('超程(赤字)相扑');
    expect(deficit?.main_lift_family).toBe('deadlift');

    const hipThrust = rows.find((r) => r.name_en === 'Barbell Hip Thrust');
    expect(hipThrust?.name).toBe('臀推');
    expect(hipThrust?.exercise_type).toBe('accessory');
    expect(hipThrust?.main_lift_family).toBeNull();
  });

  it('renames existing entries and removes merged duplicates', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    createPlanSchema(mem);
    // Seed two existing catalog rows the migration touches: one it renames, one it deletes.
    mem.public.none(`
      INSERT INTO exercises (id, name, exercise_type, muscle_groups, equipment) VALUES
        ('00000000-0000-0000-ca70-0000000002fa', '站姿杠铃推举', 'accessory', ARRAY['shoulder']::TEXT[], ARRAY['barbell']::TEXT[]),
        ('00000000-0000-0000-ca70-00000000019e', '螃蟹步', 'accessory', ARRAY['glute']::TEXT[], ARRAY['bodyweight']::TEXT[]);
    `);

    runMigration(mem, MIGRATION);

    const renamed = mem.public.many(
      `SELECT name FROM exercises WHERE id = '00000000-0000-0000-ca70-0000000002fa'`,
    ) as ExerciseRow[];
    expect(renamed).toHaveLength(1);
    expect(renamed[0]?.name).toBe('实力推');

    const deleted = mem.public.many(
      `SELECT id FROM exercises WHERE id = '00000000-0000-0000-ca70-00000000019e'`,
    );
    expect(deleted).toHaveLength(0);
  });

  it('re-points plans off a merged exercise before deleting it', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    createPlanSchema(mem);
    // Seed both merged-away exercises + their survivors, and a plan referencing
    // each merged one — exercises.id FK is ON DELETE RESTRICT, so both branches
    // (019e→0185, 0179→0199) must be re-pointed before the DELETE.
    mem.public.none(`
      INSERT INTO exercises (id, name, exercise_type, muscle_groups, equipment) VALUES
        ('00000000-0000-0000-ca70-00000000019e', '螃蟹步', 'accessory', ARRAY['glute']::TEXT[], ARRAY['bodyweight']::TEXT[]),
        ('00000000-0000-0000-ca70-000000000185', '弹力带螃蟹行走', 'accessory', ARRAY['glute']::TEXT[], ARRAY['band']::TEXT[]),
        ('00000000-0000-0000-ca70-000000000179', '熊爬肩部触摸', 'accessory', ARRAY['mobility']::TEXT[], ARRAY['bodyweight']::TEXT[]),
        ('00000000-0000-0000-ca70-000000000199', '熊爬', 'accessory', ARRAY['core']::TEXT[], ARRAY['bodyweight']::TEXT[]);
      INSERT INTO plan_exercises (id, plan_day_id, exercise_id, is_main_lift, sort_order) VALUES
        ('60000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '00000000-0000-0000-ca70-00000000019e', FALSE, 1),
        ('60000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000001', '00000000-0000-0000-ca70-000000000179', FALSE, 2);
    `);

    runMigration(mem, MIGRATION);

    const refs = mem.public.many(
      `SELECT id, exercise_id FROM plan_exercises
       WHERE id IN ('60000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000002')`,
    ) as { id: string; exercise_id: string }[];
    const refOf = (id: string) => refs.find((r) => r.id === id)?.exercise_id;
    expect(refOf('60000000-0000-4000-8000-000000000001')).toBe(
      '00000000-0000-0000-ca70-000000000185',
    ); // 弹力带螃蟹步
    expect(refOf('60000000-0000-4000-8000-000000000002')).toBe(
      '00000000-0000-0000-ca70-000000000199',
    ); // 熊爬交替换手
    expect(
      mem.public.many(
        `SELECT id FROM exercises WHERE id IN ('00000000-0000-0000-ca70-00000000019e', '00000000-0000-0000-ca70-000000000179')`,
      ),
    ).toHaveLength(0);
  });

  it('is idempotent on re-apply', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    createPlanSchema(mem);
    runMigration(mem, MIGRATION);
    runMigration(mem, MIGRATION);

    expect(mem.public.many(`SELECT id FROM exercises WHERE id IN (${newIdList})`)).toHaveLength(15);
  });
});
