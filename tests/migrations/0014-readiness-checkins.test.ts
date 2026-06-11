import { describe, expect, it } from 'vitest';

import { createBaseUsers, makeMigrationDb, runMigration } from '../helpers/migrations';

describe('migration 0014 readiness check-ins', () => {
  it('enforces one check-in per (student, day) and cascades user delete', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    runMigration(mem, 'db/migrations/0014-init-readiness-checkins.sql');

    mem.public.none(`
      INSERT INTO readiness_checkins (student_id, checkin_date, sleep_quality, mood, stress, muscle_fatigue)
      VALUES (
        '10000000-0000-4000-8000-000000000003',
        '2026-06-11',
        4, 3, 2,
        '[{"muscle_group":"quad","severity":3}]'
      );
    `);

    expect(() => {
      mem.public.none(`
        INSERT INTO readiness_checkins (student_id, checkin_date, sleep_quality, mood, stress)
        VALUES ('10000000-0000-4000-8000-000000000003', '2026-06-11', 1, 1, 1);
      `);
    }).toThrow();

    // A different day for the same student is fine.
    mem.public.none(`
      INSERT INTO readiness_checkins (student_id, checkin_date, sleep_quality, mood, stress)
      VALUES ('10000000-0000-4000-8000-000000000003', '2026-06-12', 1, 1, 1);
    `);

    mem.public.none(`
      DELETE FROM users WHERE id = '10000000-0000-4000-8000-000000000003';
    `);
    expect(mem.public.many('SELECT * FROM readiness_checkins')).toHaveLength(0);
  });

  it('CHECK-bounds the three 1-5 scales and defaults muscle_fatigue to []', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    runMigration(mem, 'db/migrations/0014-init-readiness-checkins.sql');

    expect(() => {
      mem.public.none(`
        INSERT INTO readiness_checkins (student_id, checkin_date, sleep_quality, mood, stress)
        VALUES ('10000000-0000-4000-8000-000000000003', '2026-06-11', 6, 3, 2);
      `);
    }).toThrow();
    expect(() => {
      mem.public.none(`
        INSERT INTO readiness_checkins (student_id, checkin_date, sleep_quality, mood, stress)
        VALUES ('10000000-0000-4000-8000-000000000003', '2026-06-11', 4, 0, 2);
      `);
    }).toThrow();

    mem.public.none(`
      INSERT INTO readiness_checkins (student_id, checkin_date, sleep_quality, mood, stress)
      VALUES ('10000000-0000-4000-8000-000000000003', '2026-06-11', 4, 3, 2);
    `);
    const rows = mem.public.many('SELECT muscle_fatigue FROM readiness_checkins');
    expect(rows).toHaveLength(1);
    expect(rows[0].muscle_fatigue).toEqual([]);
  });
});
