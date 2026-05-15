import { describe, expect, it } from 'vitest';

import { createBaseUsers, makeMigrationDb, runMigration } from '../helpers/migrations';

describe('migration 0003.5 profile tables', () => {
  it('creates one-to-one profile tables with cascade delete', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    runMigration(mem, 'db/migrations/0003.5-init-profile-tables.sql');

    mem.public.none(`
      INSERT INTO coach_profiles (user_id, display_name)
      VALUES ('10000000-0000-4000-8000-000000000001', 'Coach A');
      INSERT INTO student_profiles (user_id, display_name)
      VALUES ('10000000-0000-4000-8000-000000000003', 'Student A');
    `);

    expect(() => {
      mem.public.none(`
        INSERT INTO student_profiles (user_id, display_name)
        VALUES ('10000000-0000-4000-8000-000000000003', 'Duplicate');
      `);
    }).toThrow();

    mem.public.none(`
      DELETE FROM users WHERE id = '10000000-0000-4000-8000-000000000003';
    `);
    expect(mem.public.many('SELECT * FROM student_profiles')).toHaveLength(0);
  });
});
