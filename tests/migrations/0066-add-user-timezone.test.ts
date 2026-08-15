import { describe, expect, it } from 'vitest';

import { makeMigrationDb, runMigration } from '../helpers/migrations';

describe('0066 add user timezone', () => {
  it('adds a non-null Shanghai default without rewriting existing values', () => {
    const mem = makeMigrationDb();
    runMigration(mem, 'db/migrations/0001-init-users.sql');
    mem.public.none(`
      INSERT INTO users (phone, password_hash, role)
      VALUES ('+8613800000066', 'hash', 'coached_student');
    `);

    runMigration(mem, 'db/migrations/0066-add-user-timezone.sql');

    expect(mem.public.one(`SELECT timezone FROM users;`)).toEqual({
      timezone: 'Asia/Shanghai',
    });
    mem.public.none(`
      INSERT INTO users (phone, password_hash, role)
      VALUES ('+8613800000166', 'hash', 'coach');
    `);
    expect(mem.public.many(`SELECT timezone FROM users ORDER BY phone;`)).toEqual([
      { timezone: 'Asia/Shanghai' },
      { timezone: 'Asia/Shanghai' },
    ]);
  });
});
