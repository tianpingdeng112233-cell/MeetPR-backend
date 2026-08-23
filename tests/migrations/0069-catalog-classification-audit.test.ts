import { describe, expect, it } from 'vitest';

import { makeMigrationDb, runMigration } from '../helpers/migrations';

const MIGRATION = 'db/migrations/0069-catalog-classification-audit.sql';

interface ExerciseSeed {
  id: string;
  name: string;
  exerciseType?: 'accessory' | 'main_lift' | 'main_lift_variation' | undefined;
  family?: 'bench' | 'squat' | 'deadlift' | null | undefined;
  muscleGroups?: string[] | undefined;
  equipment?: string[] | undefined;
}

const classificationSeeds: ExerciseSeed[] = [
  {
    id: '00000000-0000-0000-ca70-000000000372',
    name: '窄距卧推(敞开式)',
    muscleGroups: ['triceps', 'chest'],
    equipment: ['barbell'],
  },
  {
    id: '00000000-0000-0000-ca70-000000000373',
    name: '窄距卧推(靠近式)',
    muscleGroups: ['triceps', 'chest'],
    equipment: ['barbell'],
  },
  {
    id: '00000000-0000-0000-ca70-00000000029e',
    name: '杠铃深蹲',
    muscleGroups: ['quad', 'glute'],
    equipment: ['barbell'],
  },
  {
    id: '00000000-0000-0000-ca70-000000000156',
    name: '粗杠硬拉',
    muscleGroups: ['back'],
    equipment: ['specialty_bar'],
  },
  {
    id: '00000000-0000-0000-ca70-000000000021',
    name: '深蹲跳',
    exerciseType: 'main_lift_variation',
    family: 'squat',
    muscleGroups: ['quad'],
    equipment: ['barbell'],
  },
];

const mergePairs = [
  {
    loser: '00000000-0000-0000-ca70-00000000011e',
    loserName: '早安',
    winner: '00000000-0000-0000-ca70-000000000022',
    winnerName: '早安式',
    winnerType: 'main_lift_variation' as const,
    winnerFamily: 'squat' as const,
  },
  {
    loser: '00000000-0000-0000-ca70-0000000002f0',
    loserName: '六角杠深蹲',
    winner: '00000000-0000-0000-ca70-000000000051',
    winnerName: '六角杆硬拉',
    finalWinnerName: '六角杠硬拉',
    winnerType: 'main_lift_variation' as const,
    winnerFamily: 'deadlift' as const,
  },
  {
    loser: '00000000-0000-0000-ca70-00000000029f',
    loserName: '杰弗森深蹲',
    winner: '00000000-0000-0000-ca70-000000000032',
    winnerName: 'Jefferson 硬拉',
    finalWinnerName: '杰弗森硬拉',
    winnerType: 'main_lift_variation' as const,
    winnerFamily: 'deadlift' as const,
  },
  {
    loser: '00000000-0000-0000-ca70-0000000001b6',
    loserName: '抬腿杠铃卧推',
    winner: '00000000-0000-0000-ca70-00000000005b',
    winnerName: '无腿卧推',
    winnerType: 'main_lift_variation' as const,
    winnerFamily: 'bench' as const,
  },
  {
    loser: '00000000-0000-0000-ca70-000000000053',
    loserName: '弹力带杠铃卧推',
    loserType: 'main_lift_variation' as const,
    loserFamily: 'bench' as const,
    winner: '00000000-0000-0000-ca71-000000000014',
    winnerName: '弹力带卧推',
    winnerType: 'main_lift_variation' as const,
    winnerFamily: 'bench' as const,
  },
  {
    loser: '00000000-0000-0000-ca70-0000000001f2',
    loserName: '弹力绳-卧推',
    winner: '00000000-0000-0000-ca71-000000000014',
    winnerName: '弹力带卧推',
    winnerType: 'main_lift_variation' as const,
    winnerFamily: 'bench' as const,
  },
  {
    loser: '00000000-0000-0000-ca70-000000000011',
    loserName: '背蹲地面起始设置',
    loserType: 'main_lift_variation' as const,
    loserFamily: 'squat' as const,
    winner: '00000000-0000-0000-ca70-00000000000f',
    winnerName: 'Anderson 深蹲',
    winnerType: 'main_lift_variation' as const,
    winnerFamily: 'squat' as const,
  },
  {
    loser: '00000000-0000-0000-ca70-000000000280',
    loserName: '澳式引体',
    winner: '00000000-0000-0000-ca71-00000000000d',
    winnerName: '澳大利亚引体',
  },
  {
    loser: '00000000-0000-0000-ca70-0000000003e7',
    loserName: '壶铃甩',
    winner: '00000000-0000-0000-ca70-000000000129',
    winnerName: '壶铃摆动',
  },
  {
    loser: '00000000-0000-0000-ca70-0000000002a0',
    loserName: '杠铃火箭推',
    winner: '00000000-0000-0000-ca70-000000000169',
    winnerName: '借力推举',
  },
];

const muscleCorrections = [
  [
    '00000000-0000-0000-ca70-00000000004d',
    '节奏罗马尼亚硬拉',
    ['core', 'back', 'quad'],
    ['hamstring', 'glute'],
  ],
  [
    '00000000-0000-0000-ca70-00000000000c',
    '节奏插销深蹲（架上）',
    ['core', 'back', 'quad'],
    ['quad'],
  ],
  [
    '00000000-0000-0000-ca70-0000000000e5',
    '节奏高脚杯深蹲',
    ['core', 'back', 'quad'],
    ['quad', 'glute'],
  ],
  ['00000000-0000-0000-ca70-000000000022', '早安式', ['quad'], ['hamstring', 'glute', 'back']],
  [
    '00000000-0000-0000-ca71-000000000005',
    '低杆位早安式',
    ['quad'],
    ['hamstring', 'glute', 'back'],
  ],
  [
    '00000000-0000-0000-ca71-000000000006',
    '安全杆早安式',
    ['quad'],
    ['hamstring', 'glute', 'back'],
  ],
  [
    '00000000-0000-0000-ca71-000000000007',
    '无腰带低杆位早安式',
    ['quad'],
    ['hamstring', 'glute', 'back'],
  ],
  [
    '00000000-0000-0000-ca71-000000000008',
    'PIN低杆位早安式',
    ['quad'],
    ['hamstring', 'glute', 'back'],
  ],
  [
    '00000000-0000-0000-ca70-000000000032',
    'Jefferson 硬拉',
    ['quad'],
    ['quad', 'glute', 'hamstring'],
  ],
] as const;

const equipmentCorrections = [
  ['00000000-0000-0000-ca70-000000000054', '弹力带中握卧推', ['band'], ['barbell', 'band']],
  ['00000000-0000-0000-ca70-00000000006b', '弹力带拉森卧推', ['band'], ['barbell', 'band']],
  ['00000000-0000-0000-ca70-00000000002b', '弹力带硬拉', ['band'], ['barbell', 'band']],
  ['00000000-0000-0000-ca70-000000000005', '弹力带前蹲', ['barbell'], ['barbell', 'band']],
  ['00000000-0000-0000-ca70-00000000001c', '弹力带辅助深蹲', ['barbell'], ['barbell', 'band']],
  ['00000000-0000-0000-ca70-000000000038', '弹力带辅助传统硬拉', ['barbell'], ['barbell', 'band']],
  ['00000000-0000-0000-ca70-000000000039', '弹力带辅助相扑硬拉', ['barbell'], ['barbell', 'band']],
  [
    '00000000-0000-0000-ca70-000000000048',
    '弹力带绕髋罗马尼亚硬拉',
    ['barbell'],
    ['barbell', 'band'],
  ],
  ['00000000-0000-0000-ca70-000000000141', '弹力带 pallof 推', ['other'], ['band', 'cable']],
  ['00000000-0000-0000-ca70-000000000172', '弹力带抗阻腘绳肌', ['other'], ['band']],
  ['00000000-0000-0000-ca70-000000000009', '扶手安全杆暂停深蹲', ['barbell'], ['specialty_bar']],
  ['00000000-0000-0000-ca70-00000000000a', '扶手安全杆深蹲', ['barbell'], ['specialty_bar']],
  ['00000000-0000-0000-ca70-000000000077', '地雷推', ['other'], ['barbell']],
  ['00000000-0000-0000-ca70-00000000007d', '坐姿杠铃推举', ['other'], ['barbell']],
  ['00000000-0000-0000-ca70-000000000085', '杠铃直立划船', ['other'], ['barbell']],
  ['00000000-0000-0000-ca70-000000000074', '绳索面拉', ['other'], ['cable']],
  ['00000000-0000-0000-ca70-00000000012b', '绳索穿裆拉', ['barbell'], ['cable']],
  [
    '00000000-0000-0000-ca70-0000000000e4',
    '哑铃酒杯深蹲',
    ['kettlebell'],
    ['dumbbell', 'kettlebell'],
  ],
  ['00000000-0000-0000-ca70-000000000113', '哑铃侧弓步', ['bodyweight'], ['dumbbell']],
  ['00000000-0000-0000-ca70-000000000190', '站姿哑铃肩部环绕', ['bodyweight'], ['dumbbell']],
  ['00000000-0000-0000-ca70-00000000036b', '健身球牧师哑铃弯举', ['other'], ['dumbbell']],
] as const;

const controlSeeds: ExerciseSeed[] = [
  {
    id: '00000000-0000-0000-ca70-000000000058',
    name: '窄握卧推',
    exerciseType: 'main_lift_variation',
    family: 'bench',
    muscleGroups: ['chest', 'triceps'],
    equipment: ['barbell'],
  },
  {
    id: '00000000-0000-0000-ca71-000000000009',
    name: '杠铃保加利亚深蹲',
    muscleGroups: ['quad', 'glute'],
    equipment: ['barbell'],
  },
];

function sqlArray(values: readonly string[]): string {
  return `ARRAY[${values.map((value) => `'${value}'`).join(',')}]::TEXT[]`;
}

function seedExercise(mem: ReturnType<typeof makeMigrationDb>, seed: ExerciseSeed): void {
  mem.public.none(`
    INSERT INTO exercises (
      id, name, name_en, exercise_type, main_lift_family, is_competition_lift,
      muscle_groups, equipment, movement_pattern, competition_stance
    ) VALUES (
      '${seed.id}', '${seed.name}', '${seed.name} EN', '${seed.exerciseType ?? 'accessory'}',
      ${seed.family ? `'${seed.family}'` : 'NULL'}, FALSE,
      ${sqlArray(seed.muscleGroups ?? ['core'])}, ${sqlArray(seed.equipment ?? ['other'])},
      ARRAY['audit_sentinel']::TEXT[], 'raw'
    );
  `);
}

function seedSchema(mem: ReturnType<typeof makeMigrationDb>): void {
  mem.public.none(`
    CREATE TABLE exercises (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      name_en TEXT,
      exercise_type TEXT NOT NULL,
      main_lift_family TEXT,
      is_competition_lift BOOLEAN NOT NULL DEFAULT FALSE,
      muscle_groups TEXT[] NOT NULL,
      equipment TEXT[] NOT NULL,
      movement_pattern TEXT[] NOT NULL DEFAULT '{}',
      competition_stance TEXT,
      base_exercise_id UUID REFERENCES exercises(id) ON DELETE SET NULL,
      created_by_coach_id UUID,
      CONSTRAINT exercises_main_lift_family_consistency CHECK (
        (exercise_type = 'accessory' AND main_lift_family IS NULL) OR
        (exercise_type IN ('main_lift', 'main_lift_variation') AND main_lift_family IS NOT NULL)
      )
    );
    CREATE TABLE plan_exercises (
      id UUID PRIMARY KEY,
      exercise_id UUID NOT NULL REFERENCES exercises(id) ON DELETE RESTRICT
    );
    CREATE TABLE set_logs (
      id UUID PRIMARY KEY,
      exercise_id UUID NOT NULL REFERENCES exercises(id) ON DELETE RESTRICT
    );
  `);

  for (const seed of classificationSeeds) seedExercise(mem, seed);

  const uniqueMergeExercises = new Map<string, ExerciseSeed>();
  for (const pair of mergePairs) {
    uniqueMergeExercises.set(pair.loser, {
      id: pair.loser,
      name: pair.loserName,
      exerciseType: pair.loserType,
      family: pair.loserFamily,
    });
    uniqueMergeExercises.set(pair.winner, {
      id: pair.winner,
      name: pair.winnerName,
      exerciseType: pair.winnerType,
      family: pair.winnerFamily,
      muscleGroups:
        pair.winner === '00000000-0000-0000-ca70-000000000022' ||
        pair.winner === '00000000-0000-0000-ca70-000000000032'
          ? ['quad']
          : undefined,
    });
  }
  for (const seed of uniqueMergeExercises.values()) seedExercise(mem, seed);

  const existingIds = new Set([
    ...classificationSeeds.map(({ id }) => id),
    ...uniqueMergeExercises.keys(),
  ]);
  for (const [id, name, before] of muscleCorrections) {
    if (!existingIds.has(id)) {
      seedExercise(mem, { id, name, muscleGroups: [...before] });
      existingIds.add(id);
    }
  }
  for (const [id, name, before] of equipmentCorrections) {
    if (!existingIds.has(id)) {
      seedExercise(mem, { id, name, equipment: [...before] });
      existingIds.add(id);
    }
  }
  for (const seed of controlSeeds) seedExercise(mem, seed);

  mergePairs.forEach((pair, index) => {
    const suffix = String(index + 1).padStart(12, '0');
    const baseRefId = `90000000-0000-4000-8000-${suffix}`;
    seedExercise(mem, { id: baseRefId, name: `base ref ${String(index + 1)}` });
    mem.public.none(`
      UPDATE exercises SET base_exercise_id = '${pair.loser}' WHERE id = '${baseRefId}';
      INSERT INTO plan_exercises (id, exercise_id)
        VALUES ('91000000-0000-4000-8000-${suffix}', '${pair.loser}');
      INSERT INTO set_logs (id, exercise_id)
        VALUES ('92000000-0000-4000-8000-${suffix}', '${pair.loser}');
    `);
  });
}

function selectControl(mem: ReturnType<typeof makeMigrationDb>, id: string): unknown {
  return mem.public.one(`SELECT * FROM exercises WHERE id = '${id}'`) as unknown;
}

describe('migration 0069 catalog classification audit', () => {
  it('applies every approved classification, merge, muscle, and equipment correction', () => {
    const mem = makeMigrationDb();
    seedSchema(mem);
    const controlsBefore = controlSeeds.map(({ id }) => selectControl(mem, id));

    runMigration(mem, MIGRATION);

    expect(
      mem.public.many(`
        SELECT id, exercise_type, main_lift_family, muscle_groups
        FROM exercises
        WHERE id IN (${classificationSeeds.map(({ id }) => `'${id}'`).join(',')})
        ORDER BY id
      `),
    ).toEqual([
      {
        id: '00000000-0000-0000-ca70-000000000021',
        exercise_type: 'accessory',
        main_lift_family: null,
        muscle_groups: ['quad'],
      },
      {
        id: '00000000-0000-0000-ca70-000000000156',
        exercise_type: 'main_lift_variation',
        main_lift_family: 'deadlift',
        muscle_groups: ['hamstring', 'glute', 'back'],
      },
      {
        id: '00000000-0000-0000-ca70-00000000029e',
        exercise_type: 'main_lift_variation',
        main_lift_family: 'squat',
        muscle_groups: ['quad', 'glute'],
      },
      {
        id: '00000000-0000-0000-ca70-000000000372',
        exercise_type: 'main_lift_variation',
        main_lift_family: 'bench',
        muscle_groups: ['triceps', 'chest'],
      },
      {
        id: '00000000-0000-0000-ca70-000000000373',
        exercise_type: 'main_lift_variation',
        main_lift_family: 'bench',
        muscle_groups: ['triceps', 'chest'],
      },
    ]);

    mergePairs.forEach((pair, index) => {
      expect(mem.public.many(`SELECT id FROM exercises WHERE id = '${pair.loser}'`)).toEqual([]);
      expect(mem.public.many(`SELECT id, name FROM exercises WHERE id = '${pair.winner}'`)).toEqual(
        [{ id: pair.winner, name: pair.finalWinnerName ?? pair.winnerName }],
      );
      const suffix = String(index + 1).padStart(12, '0');
      expect(
        mem.public.one(
          `SELECT exercise_id FROM plan_exercises WHERE id = '91000000-0000-4000-8000-${suffix}'`,
        ),
      ).toEqual({ exercise_id: pair.winner });
      expect(
        mem.public.one(
          `SELECT exercise_id FROM set_logs WHERE id = '92000000-0000-4000-8000-${suffix}'`,
        ),
      ).toEqual({ exercise_id: pair.winner });
      expect(
        mem.public.one(
          `SELECT base_exercise_id FROM exercises WHERE id = '90000000-0000-4000-8000-${suffix}'`,
        ),
      ).toEqual({ base_exercise_id: pair.winner });
    });

    for (const [id, , , after] of muscleCorrections) {
      expect(mem.public.one(`SELECT muscle_groups FROM exercises WHERE id = '${id}'`)).toEqual({
        muscle_groups: [...after],
      });
    }
    for (const [id, , , after] of equipmentCorrections) {
      expect(mem.public.one(`SELECT equipment FROM exercises WHERE id = '${id}'`)).toEqual({
        equipment: [...after],
      });
    }
    controlSeeds.forEach(({ id }, index) => {
      expect(selectControl(mem, id)).toEqual(controlsBefore[index]);
    });
    expect(() => {
      mem.public.many(`SELECT * FROM _0069_winner_exists`);
    }).toThrow();
    expect(() => {
      mem.public.many(`SELECT * FROM _0069_target_exists`);
    }).toThrow();
  });

  it('aborts the whole transaction before writing when a winner is missing', () => {
    const mem = makeMigrationDb();
    seedSchema(mem);
    mem.public.none(`DELETE FROM exercises WHERE id = '00000000-0000-0000-ca70-000000000022'`);

    expect(() => {
      runMigration(mem, MIGRATION);
    }).toThrow();

    expect(
      mem.public.one(
        `SELECT exercise_type, main_lift_family FROM exercises WHERE id = '00000000-0000-0000-ca70-000000000372'`,
      ),
    ).toEqual({ exercise_type: 'accessory', main_lift_family: null });
    expect(
      mem.public.one(`SELECT id FROM exercises WHERE id = '00000000-0000-0000-ca70-00000000011e'`),
    ).toEqual({ id: '00000000-0000-0000-ca70-00000000011e' });
  });

  it('aborts the whole transaction when a classification target is missing or renamed', () => {
    const missing = makeMigrationDb();
    seedSchema(missing);
    missing.public.none(`DELETE FROM exercises WHERE id = '00000000-0000-0000-ca70-000000000021'`);

    expect(() => {
      runMigration(missing, MIGRATION);
    }).toThrow();
    expect(
      missing.public.one(
        `SELECT exercise_type, main_lift_family FROM exercises WHERE id = '00000000-0000-0000-ca70-000000000372'`,
      ),
    ).toEqual({ exercise_type: 'accessory', main_lift_family: null });
    expect(
      missing.public.one(
        `SELECT id FROM exercises WHERE id = '00000000-0000-0000-ca70-00000000011e'`,
      ),
    ).toEqual({ id: '00000000-0000-0000-ca70-00000000011e' });

    const renamed = makeMigrationDb();
    seedSchema(renamed);
    renamed.public.none(
      `UPDATE exercises SET name = '别的动作' WHERE id = '00000000-0000-0000-ca70-000000000372'`,
    );

    expect(() => {
      runMigration(renamed, MIGRATION);
    }).toThrow();
    expect(
      renamed.public.one(
        `SELECT exercise_type, main_lift_family FROM exercises WHERE id = '00000000-0000-0000-ca70-000000000372'`,
      ),
    ).toEqual({ exercise_type: 'accessory', main_lift_family: null });
  });

  it('allows a replay after every loser has already been removed', () => {
    const mem = makeMigrationDb();
    seedSchema(mem);

    runMigration(mem, MIGRATION);

    expect(() => {
      runMigration(mem, MIGRATION);
    }).not.toThrow();
    expect(
      mem.public.many(`
        SELECT id FROM exercises
        WHERE id IN (${mergePairs.map(({ loser }) => `'${loser}'`).join(',')})
      `),
    ).toEqual([]);
  });
});
