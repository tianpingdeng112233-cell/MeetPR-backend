import { describe, expect, it } from 'vitest';

import {
  createBaseUsers,
  createPlanSchema,
  makeMigrationDb,
  runMigration,
} from '../helpers/migrations';

const MIGRATION = 'db/migrations/0025-sync-squat-rdl-rename.sql';

// #1 — the 2 squat variations this migration adds (ids ca71-…0010/0011).
const NEW_IDS = ['00000000-0000-0000-ca71-000000000010', '00000000-0000-0000-ca71-000000000011'];
const newIdList = NEW_IDS.map((id) => `'${id}'`).join(', ');

// #3 — the 9 deadlift exercises renamed RDL/罗拉 → 罗马尼亚硬拉 (old name → expected).
const RENAMES: { id: string; oldName: string; nameEn: string; expected: string }[] = [
  {
    id: '00000000-0000-0000-ca70-000000000048',
    oldName: '弹力带绕髋RDL',
    nameEn: 'RDL w/ Band Around Hips',
    expected: '弹力带绕髋罗马尼亚硬拉',
  },
  {
    id: '00000000-0000-0000-ca70-000000000049',
    oldName: '抓举握距RDL',
    nameEn: 'Snatch Grip RDL',
    expected: '抓举握距罗马尼亚硬拉',
  },
  {
    id: '00000000-0000-0000-ca70-00000000004a',
    oldName: '前后站单腿罗拉',
    nameEn: 'Staggered Stance RDL',
    expected: '前后站单腿罗马尼亚硬拉',
  },
  {
    id: '00000000-0000-0000-ca70-00000000004b',
    oldName: '相扑RDL',
    nameEn: 'Sumo RDL',
    expected: '相扑罗马尼亚硬拉',
  },
  {
    id: '00000000-0000-0000-ca70-00000000004d',
    oldName: '节奏RDL',
    nameEn: 'Tempo RDL',
    expected: '节奏罗马尼亚硬拉',
  },
  {
    id: '00000000-0000-0000-ca70-000000000108',
    oldName: '单腿RDL',
    nameEn: 'Single Leg RDL',
    expected: '单腿罗马尼亚硬拉',
  },
  {
    id: '00000000-0000-0000-ca70-000000000109',
    oldName: '单腿 RDL(纯单腿)',
    nameEn: 'Single Leg RDL (Pure)',
    expected: '单腿罗马尼亚硬拉(纯单腿)',
  },
  {
    id: '00000000-0000-0000-ca70-00000000012c',
    oldName: 'B 站距 RDL',
    nameEn: 'B-Stance RDL',
    expected: 'B 站距罗马尼亚硬拉',
  },
  {
    id: '00000000-0000-0000-ca70-00000000012d',
    oldName: '单腿 RDL(B 站距)',
    nameEn: 'Single Leg RDL (B-Stance)',
    expected: '单腿罗马尼亚硬拉(B 站距)',
  },
];

interface ExerciseRow {
  id: string;
  name: string;
  name_en: string | null;
  exercise_type: string;
  main_lift_family: string | null;
  muscle_groups: string[];
  equipment: string[];
  movement_pattern: string[];
}

// The real catalog table is built by 0002 + the generated 0002.1, which pg-mem can't
// execute; createPlanSchema stands in with the same columns. The 9 renamed rows are
// seeded here with their pre-rename names so the UPDATE-by-id has targets.
function seedRenameRows(mem: ReturnType<typeof makeMigrationDb>) {
  for (const r of RENAMES) {
    mem.public.none(
      `INSERT INTO exercises (id, name, name_en, exercise_type, main_lift_family, muscle_groups, equipment, movement_pattern)
       VALUES ('${r.id}', '${r.oldName}', '${r.nameEn}', 'main_lift_variation', 'deadlift', ARRAY['hamstring']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY['hip_hinge']::TEXT[]);`,
    );
  }
}

describe('migration 0025 squat add + RDL rename', () => {
  it('inserts the two low-bar squat variations with the expected metadata', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    createPlanSchema(mem);
    runMigration(mem, MIGRATION);

    const rows = mem.public.many(
      `SELECT id, name, name_en, exercise_type, main_lift_family, muscle_groups, equipment, movement_pattern
       FROM exercises WHERE id IN (${newIdList})`,
    ) as ExerciseRow[];
    expect(rows).toHaveLength(2);

    const paused = rows.find((r) => r.name_en === 'Low Bar Paused Squat');
    expect(paused?.name).toBe('低杠位暂停深蹲');
    expect(paused?.exercise_type).toBe('main_lift_variation');
    expect(paused?.main_lift_family).toBe('squat');
    expect(paused?.muscle_groups).toEqual(['quad']);
    expect(paused?.equipment).toEqual(['barbell']);
    expect(paused?.movement_pattern).toEqual(['squat']);

    const tempo = rows.find((r) => r.name_en === 'Low Bar Tempo Squat');
    expect(tempo?.name).toBe('低杠位节奏深蹲');
    expect(tempo?.main_lift_family).toBe('squat');
  });

  it('renames the nine RDL/罗拉 entries to 罗马尼亚硬拉 without touching id or name_en', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    createPlanSchema(mem);
    seedRenameRows(mem);
    runMigration(mem, MIGRATION);

    for (const r of RENAMES) {
      const rows = mem.public.many(
        `SELECT name, name_en FROM exercises WHERE id = '${r.id}'`,
      ) as ExerciseRow[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe(r.expected);
      expect(rows[0]?.name_en).toBe(r.nameEn); // name_en keeps the RDL abbreviation
    }
  });

  it('is idempotent on re-apply', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    createPlanSchema(mem);
    seedRenameRows(mem);
    runMigration(mem, MIGRATION);
    runMigration(mem, MIGRATION);

    expect(mem.public.many(`SELECT id FROM exercises WHERE id IN (${newIdList})`)).toHaveLength(2);
    const single = mem.public.many(
      `SELECT name FROM exercises WHERE id = '00000000-0000-0000-ca70-000000000108'`,
    ) as ExerciseRow[];
    expect(single[0]?.name).toBe('单腿罗马尼亚硬拉');
  });
});
