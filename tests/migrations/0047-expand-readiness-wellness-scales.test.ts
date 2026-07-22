import { describe, expect, it } from 'vitest';

import { createBaseUsers, makeMigrationDb, runMigration } from '../helpers/migrations';

const MIGRATION = 'db/migrations/0047-expand-readiness-wellness-scales.sql';
const STUDENT = '10000000-0000-4000-8000-000000000003';

describe('migration 0047 readiness wellness scales', () => {
  it('maps stored muscle-fatigue severity 1/2/3 to 1/3/5', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    runMigration(mem, 'db/migrations/0014-init-readiness-checkins.sql');

    mem.public.none(`
      INSERT INTO readiness_checkins (
        student_id, checkin_date, sleep_quality, mood, stress, muscle_fatigue
      ) VALUES (
        '${STUDENT}',
        '2026-07-21',
        4,
        3,
        2,
        '[
          {"muscle_group":"quad","severity":1},
          {"muscle_group":"hamstring","severity":2},
          {"muscle_group":"core","severity":3}
        ]'
      );
    `);

    runMigration(mem, MIGRATION);

    const row = mem.public.one(`
      SELECT muscle_fatigue, muscle_fatigue_scale_version
      FROM readiness_checkins
      WHERE student_id = '${STUDENT}';
    `);
    expect(row.muscle_fatigue).toEqual([
      { muscle_group: 'quad', severity: 1 },
      { muscle_group: 'hamstring', severity: 3 },
      { muscle_group: 'core', severity: 5 },
    ]);
    expect(row.muscle_fatigue_scale_version).toBe(5);
  });

  it('is idempotent when re-applied during a staging drill', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    runMigration(mem, 'db/migrations/0014-init-readiness-checkins.sql');

    mem.public.none(`
      INSERT INTO readiness_checkins (
        student_id, checkin_date, sleep_quality, mood, stress, muscle_fatigue
      ) VALUES (
        '${STUDENT}',
        '2026-07-21',
        4,
        3,
        2,
        '[{"muscle_group":"hamstring","severity":2}]'
      );
    `);

    runMigration(mem, MIGRATION);
    runMigration(mem, MIGRATION);

    const row = mem.public.one(`
      SELECT muscle_fatigue
      FROM readiness_checkins
      WHERE student_id = '${STUDENT}';
    `);
    expect(row.muscle_fatigue).toEqual([{ muscle_group: 'hamstring', severity: 3 }]);
  });
});
