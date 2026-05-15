import { describe, expect, it } from 'vitest';

import { makeMigrationDb, runMigration } from '../helpers/migrations';

describe('migration 0004 seed internal users', () => {
  it('inserts 2 users, 2 profiles, and 1 accepted bind idempotently without bcrypt placeholders', () => {
    const mem = makeMigrationDb();
    runMigration(mem, 'db/migrations/0001-init-users.sql');
    runMigration(mem, 'db/migrations/0003.5-init-profile-tables.sql');
    runMigration(mem, 'db/migrations/0003.6-init-bind-requests.sql');

    runMigration(mem, 'db/migrations/0004-seed-internal-users.sql');
    runMigration(mem, 'db/migrations/0004-seed-internal-users.sql');

    expect(mem.public.many('SELECT * FROM users')).toHaveLength(2);
    expect(mem.public.many('SELECT * FROM coach_profiles')).toHaveLength(1);
    expect(mem.public.many('SELECT * FROM student_profiles')).toHaveLength(1);
    expect(mem.public.many('SELECT * FROM bind_requests')).toHaveLength(1);
    expect(mem.public.many(`SELECT * FROM users WHERE password_hash LIKE '$2b$%'`)).toHaveLength(0);
  });
});
