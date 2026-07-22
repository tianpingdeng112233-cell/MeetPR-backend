import { describe, expect, it } from 'vitest';

import { createBaseUsers, makeMigrationDb, runMigration } from '../helpers/migrations';

const MIGRATION = 'db/migrations/0047-expand-readiness-wellness-scales.sql';
const STUDENT = '10000000-0000-4000-8000-000000000003';

function seedCheckin(
  mem: ReturnType<typeof makeMigrationDb>,
  date: string,
  muscleFatigue: string,
): void {
  mem.public.none(`
    INSERT INTO readiness_checkins (
      student_id, checkin_date, sleep_quality, mood, stress, muscle_fatigue
    ) VALUES ('${STUDENT}', '${date}', 4, 3, 2, '${muscleFatigue}');
  `);
}

describe('migration 0047 readiness wellness scales', () => {
  it('maps stored muscle-fatigue severity 1/2/3 to 1/2/4', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    runMigration(mem, 'db/migrations/0014-init-readiness-checkins.sql');
    seedCheckin(
      mem,
      '2026-07-21',
      `[
        {"muscle_group":"quad","severity":1},
        {"muscle_group":"hamstring","severity":2},
        {"muscle_group":"core","severity":3}
      ]`,
    );

    runMigration(mem, MIGRATION);

    const row = mem.public.one(`
      SELECT muscle_fatigue, muscle_fatigue_scale_version
      FROM readiness_checkins
      WHERE student_id = '${STUDENT}';
    `);
    // 1 和 2 恒等;只有旧的最高档「重」升到新的最高档「严重」。
    expect(row.muscle_fatigue).toEqual([
      { muscle_group: 'quad', severity: 1 },
      { muscle_group: 'hamstring', severity: 2 },
      { muscle_group: 'core', severity: 4 },
    ]);
    expect(row.muscle_fatigue_scale_version).toBe(4);
  });

  it('is idempotent when re-applied during a staging drill', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    runMigration(mem, 'db/migrations/0014-init-readiness-checkins.sql');
    seedCheckin(mem, '2026-07-21', '[{"muscle_group":"hamstring","severity":3}]');

    runMigration(mem, MIGRATION);
    runMigration(mem, MIGRATION);

    const row = mem.public.one(`
      SELECT muscle_fatigue FROM readiness_checkins WHERE student_id = '${STUDENT}';
    `);
    expect(row.muscle_fatigue).toEqual([{ muscle_group: 'hamstring', severity: 4 }]);
  });

  it('leaves a post-migration severity 3 alone on re-run', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    runMigration(mem, 'db/migrations/0014-init-readiness-checkins.sql');
    runMigration(mem, MIGRATION);

    // 迁移后写入的「明显」是合法值,不是待迁移的旧「重」。若幂等只靠
    // 「表里还有没有 3」判断,这一行会被错误升成 4。
    seedCheckin(mem, '2026-07-22', '[{"muscle_group":"glute","severity":3}]');
    runMigration(mem, MIGRATION);

    const row = mem.public.one(`
      SELECT muscle_fatigue, muscle_fatigue_scale_version
      FROM readiness_checkins
      WHERE checkin_date = '2026-07-22';
    `);
    expect(row.muscle_fatigue).toEqual([{ muscle_group: 'glute', severity: 3 }]);
    expect(row.muscle_fatigue_scale_version).toBe(4);
  });
});
