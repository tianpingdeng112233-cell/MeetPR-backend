import { describe, expect, it } from 'vitest';

import {
  createBaseUsers,
  createPlanSchema,
  makeMigrationDb,
  runMigration,
} from '../helpers/migrations';

const MIGRATION = 'db/migrations/0026-dedup-duplicate-name-en.sql';

// The 10 duplicate-nameEn merges: the merged-away id folds into the survivor id.
const REMAP: { del: string; keep: string; delName: string; keepName: string; nameEn: string }[] = [
  {
    del: '00000000-0000-0000-ca70-000000000031',
    keep: '00000000-0000-0000-ca71-00000000000b',
    delName: '相扑站高 (下陷)硬拉',
    keepName: '超程(赤字)相扑',
    nameEn: 'Deficit Sumo Deadlift',
  },
  {
    del: '00000000-0000-0000-ca70-0000000001ca',
    keep: '00000000-0000-0000-ca70-00000000008b',
    delName: '绳索十字夹胸',
    keepName: '绳索交叉',
    nameEn: 'Cable Crossover',
  },
  {
    del: '00000000-0000-0000-ca70-0000000001cb',
    keep: '00000000-0000-0000-ca70-00000000008e',
    delName: '绳索夹胸',
    keepName: '绳索飞鸟',
    nameEn: 'Cable Fly',
  },
  {
    del: '00000000-0000-0000-ca70-000000000095',
    keep: '00000000-0000-0000-ca70-0000000001df',
    delName: '器械胸推',
    keepName: '器械推胸',
    nameEn: 'Machine Chest Press',
  },
  {
    del: '00000000-0000-0000-ca70-0000000000b4',
    keep: '00000000-0000-0000-ca70-000000000221',
    delName: '彭德雷划船（潘德雷）',
    keepName: '潘德雷划船',
    nameEn: 'Pendlay Row',
  },
  {
    del: '00000000-0000-0000-ca70-0000000000f1',
    keep: '00000000-0000-0000-ca70-0000000002b6',
    delName: '摆锤深蹲',
    keepName: '钟摆深蹲',
    nameEn: 'Pendulum Squat',
  },
  {
    del: '00000000-0000-0000-ca71-00000000000e',
    keep: '00000000-0000-0000-ca70-000000000125',
    delName: '臀推',
    keepName: '杠铃臀冲',
    nameEn: 'Barbell Hip Thrust',
  },
  {
    del: '00000000-0000-0000-ca70-000000000270',
    keep: '00000000-0000-0000-ca70-00000000027b',
    delName: '弹力绳-坐姿划船',
    keepName: '弹力带坐姿划船',
    nameEn: 'Band Seated Row',
  },
  {
    del: '00000000-0000-0000-ca70-0000000002d6',
    keep: '00000000-0000-0000-ca70-000000000413',
    delName: '弹力带-腿外展',
    keepName: '弹力带髋外展',
    nameEn: 'Band Hip Abduction',
  },
  {
    del: '00000000-0000-0000-ca70-00000000020c',
    keep: '00000000-0000-0000-ca70-00000000020b',
    delName: '单侧射手俯卧撑',
    keepName: '射手俯卧撑',
    nameEn: 'Archer Push-Up',
  },
];

const PLAN_DAY = '40000000-0000-4000-8000-000000000001'; // seeded by createPlanSchema

interface ExerciseRow {
  id: string;
  name: string;
}
interface PlanExerciseRow {
  id: string;
  exercise_id: string;
}

// Both the survivor and the merged-away duplicate exist pre-migration (in prod they are
// seeded by 0002.1 / 0019). createPlanSchema's exercises table stands in for the real
// catalog table (pg-mem can't execute the generated 0002.1).
function seedExercises(mem: ReturnType<typeof makeMigrationDb>) {
  const insert = (id: string, name: string, nameEn: string) => {
    mem.public.none(
      `INSERT INTO exercises (id, name, name_en, exercise_type, main_lift_family, muscle_groups, equipment, movement_pattern)
       VALUES ('${id}', '${name.replace(/'/g, "''")}', '${nameEn}', 'accessory', NULL, ARRAY['chest']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY['other']::TEXT[]);`,
    );
  };
  for (const r of REMAP) {
    insert(r.del, r.delName, r.nameEn);
    insert(r.keep, r.keepName, r.nameEn);
  }
}

// One plan_exercise per merged-away id, so the re-point can be observed for each.
function seedPlanReferences(mem: ReturnType<typeof makeMigrationDb>) {
  REMAP.forEach((r, i) => {
    const peId = `60000000-0000-4000-8000-0000000000${String(i + 10)}`;
    mem.public.none(
      `INSERT INTO plan_exercises (id, plan_day_id, exercise_id, is_main_lift, sort_order)
       VALUES ('${peId}', '${PLAN_DAY}', '${r.del}', FALSE, ${String(i)});`,
    );
  });
}

describe('migration 0025 duplicate-nameEn dedup', () => {
  it('removes the 10 merged-away duplicates and keeps every survivor', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    createPlanSchema(mem);
    seedExercises(mem);
    runMigration(mem, MIGRATION);

    for (const r of REMAP) {
      const gone = mem.public.many(
        `SELECT id FROM exercises WHERE id = '${r.del}'`,
      ) as ExerciseRow[];
      expect(gone, `${r.delName} should be deleted`).toHaveLength(0);

      const survivor = mem.public.many(
        `SELECT id, name FROM exercises WHERE id = '${r.keep}'`,
      ) as ExerciseRow[];
      expect(survivor, `${r.keepName} should survive`).toHaveLength(1);
      expect(survivor[0]?.name).toBe(r.keepName);
    }
  });

  it('re-points every plan_exercises reference off the duplicate onto the survivor', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    createPlanSchema(mem);
    seedExercises(mem);
    seedPlanReferences(mem);
    runMigration(mem, MIGRATION);

    for (const r of REMAP) {
      const stillOnDuplicate = mem.public.many(
        `SELECT id FROM plan_exercises WHERE exercise_id = '${r.del}'`,
      ) as PlanExerciseRow[];
      expect(stillOnDuplicate, `no plan may reference deleted ${r.delName}`).toHaveLength(0);

      const onSurvivor = mem.public.many(
        `SELECT id FROM plan_exercises WHERE exercise_id = '${r.keep}'`,
      ) as PlanExerciseRow[];
      expect(onSurvivor.length, `plan re-pointed to ${r.keepName}`).toBeGreaterThanOrEqual(1);
    }
  });

  it('is idempotent on re-apply', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    createPlanSchema(mem);
    seedExercises(mem);
    seedPlanReferences(mem);
    runMigration(mem, MIGRATION);
    runMigration(mem, MIGRATION);

    const survivors = mem.public.many(
      `SELECT id FROM exercises WHERE id IN (${REMAP.map((r) => `'${r.keep}'`).join(', ')})`,
    ) as ExerciseRow[];
    expect(survivors).toHaveLength(10);

    const duplicates = mem.public.many(
      `SELECT id FROM exercises WHERE id IN (${REMAP.map((r) => `'${r.del}'`).join(', ')})`,
    ) as ExerciseRow[];
    expect(duplicates).toHaveLength(0);
  });
});
