import { describe, expect, it } from 'vitest';

import { makeMigrationDb, runMigration } from '../helpers/migrations';

const COMP_BENCH_ID = '40c56af8-69d8-4a4a-a690-526ee38d081b';
const BARBELL_BENCH_ID = '00000000-0000-0000-ca70-0000000001b4';

function seedSchema(mem: ReturnType<typeof makeMigrationDb>) {
  mem.public.none(`
    CREATE TABLE exercises (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      name_en TEXT,
      exercise_type TEXT NOT NULL,
      main_lift_family TEXT,
      is_competition_lift BOOLEAN NOT NULL DEFAULT FALSE,
      muscle_groups TEXT[] NOT NULL,
      equipment TEXT[] NOT NULL,
      movement_pattern TEXT[] NOT NULL DEFAULT '{}',
      competition_stance TEXT,
      created_by_coach_id UUID,

      CONSTRAINT exercises_main_lift_family_consistency CHECK (
        (exercise_type = 'accessory' AND main_lift_family IS NULL) OR
        (exercise_type IN ('main_lift', 'main_lift_variation') AND main_lift_family IS NOT NULL)
      )
    );

    INSERT INTO exercises (id, name, name_en, exercise_type, main_lift_family, is_competition_lift, muscle_groups, equipment, movement_pattern) VALUES
      ('${COMP_BENCH_ID}', '竞技卧推', 'Competition Bench Press', 'main_lift', 'bench', TRUE,
        ARRAY['chest','triceps','shoulder']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY['horizontal_push']::TEXT[]),
      ('${BARBELL_BENCH_ID}', '杠铃卧推', 'Barbell Bench Press', 'accessory', NULL, FALSE,
        ARRAY['chest']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY['horizontal_push']::TEXT[]),
      ('00000000-0000-0000-ca70-000000000057', '暂停卧推', 'Paused Bench Press', 'main_lift_variation', 'bench', FALSE,
        ARRAY['chest','triceps']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY['horizontal_push']::TEXT[]);
  `);
}

function expectPromotedEndState(mem: ReturnType<typeof makeMigrationDb>) {
  // 杠铃卧推 joins the main-lift-variation bucket; every other label survives.
  expect(
    mem.public.many(
      `SELECT id, name, name_en, exercise_type, main_lift_family, is_competition_lift,
              muscle_groups, equipment, movement_pattern, competition_stance
       FROM exercises WHERE id = '${BARBELL_BENCH_ID}'`,
    ),
  ).toEqual([
    {
      id: BARBELL_BENCH_ID,
      name: '杠铃卧推',
      name_en: 'Barbell Bench Press',
      exercise_type: 'main_lift_variation',
      main_lift_family: 'bench',
      is_competition_lift: false,
      muscle_groups: ['chest'],
      equipment: ['barbell'],
      movement_pattern: ['horizontal_push'],
      competition_stance: null,
    },
  ]);

  // 竞技卧推 stays the one and only competition bench, untouched.
  expect(
    mem.public.many(
      `SELECT name, exercise_type, is_competition_lift FROM exercises
       WHERE main_lift_family = 'bench' AND is_competition_lift = TRUE`,
    ),
  ).toEqual([{ name: '竞技卧推', exercise_type: 'main_lift', is_competition_lift: true }]);

  // Guard table never leaks past the migration.
  expect(() => {
    mem.public.many(`SELECT * FROM _0056_target_exists`);
  }).toThrow();
}

describe('migration 0056 promote barbell bench to main lift variation', () => {
  it('promotes 杠铃卧推 to main_lift_variation/bench and touches nothing else', () => {
    const mem = makeMigrationDb();
    seedSchema(mem);

    runMigration(mem, 'db/migrations/0056-promote-barbell-bench-main-lift-variation.sql');

    expectPromotedEndState(mem);
    expect(
      mem.public.many(
        `SELECT name, exercise_type FROM exercises WHERE id = '00000000-0000-0000-ca70-000000000057'`,
      ),
    ).toEqual([{ name: '暂停卧推', exercise_type: 'main_lift_variation' }]);
  });

  it('is safe to run twice: the second run is a no-op', () => {
    const mem = makeMigrationDb();
    seedSchema(mem);

    runMigration(mem, 'db/migrations/0056-promote-barbell-bench-main-lift-variation.sql');
    runMigration(mem, 'db/migrations/0056-promote-barbell-bench-main-lift-variation.sql');

    expectPromotedEndState(mem);
  });

  it('aborts before any write when the target row is missing', () => {
    const mem = makeMigrationDb();
    seedSchema(mem);
    mem.public.none(`DELETE FROM exercises WHERE id = '${BARBELL_BENCH_ID}'`);

    expect(() => {
      runMigration(mem, 'db/migrations/0056-promote-barbell-bench-main-lift-variation.sql');
    }).toThrow();

    // Nothing else was touched.
    expect(
      mem.public.many(`SELECT name, exercise_type FROM exercises WHERE id = '${COMP_BENCH_ID}'`),
    ).toEqual([{ name: '竞技卧推', exercise_type: 'main_lift' }]);
  });

  it('aborts when the id points at a different exercise than expected', () => {
    const mem = makeMigrationDb();
    seedSchema(mem);
    mem.public.none(`UPDATE exercises SET name = '别的动作' WHERE id = '${BARBELL_BENCH_ID}'`);

    expect(() => {
      runMigration(mem, 'db/migrations/0056-promote-barbell-bench-main-lift-variation.sql');
    }).toThrow();

    expect(
      mem.public.many(`SELECT exercise_type FROM exercises WHERE id = '${BARBELL_BENCH_ID}'`),
    ).toEqual([{ exercise_type: 'accessory' }]);
  });
});
