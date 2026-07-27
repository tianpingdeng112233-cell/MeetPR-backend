import { describe, expect, it } from 'vitest';

import { createBaseUsers, makeMigrationDb, runMigration } from '../helpers/migrations';

const MIGRATION = 'db/migrations/0050-anonymized-account-deletion.sql';

describe('migration 0050 anonymized account deletion', () => {
  it('adds deleted_at and lets a deleted row release its phone number', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    runMigration(mem, MIGRATION);

    // Live rows are untouched: deleted_at defaults to NULL.
    expect(
      mem.public.many(`SELECT count(*)::int AS n FROM users WHERE deleted_at IS NULL`),
    ).toEqual([{ n: 3 }]);

    mem.public.none(`
      UPDATE users
      SET phone = NULL, deleted_at = now()
      WHERE id = '10000000-0000-4000-8000-000000000003';
    `);

    // The number is free again — re-registering it must not collide.
    mem.public.none(`
      INSERT INTO users (id, phone, password_hash, role)
      VALUES ('10000000-0000-4000-8000-000000000004', '+8613800010003', 'hash', 'coached_student');
    `);

    expect(
      mem.public.many(`SELECT id::text AS id FROM users WHERE phone = '+8613800010003'`),
    ).toEqual([{ id: '10000000-0000-4000-8000-000000000004' }]);
  });

  it('lets several anonymized rows coexist with a NULL phone', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    runMigration(mem, MIGRATION);

    // NULLs are distinct under a plain UNIQUE — this is what makes anonymizing
    // more than one account possible without a partial index.
    mem.public.none(`UPDATE users SET phone = NULL, deleted_at = now()`);

    expect(mem.public.many(`SELECT count(*)::int AS n FROM users WHERE phone IS NULL`)).toEqual([
      { n: 3 },
    ]);
  });

  it('still requires a phone on a live account', () => {
    const mem = makeMigrationDb();
    createBaseUsers(mem);
    runMigration(mem, MIGRATION);

    expect(() => {
      mem.public.none(`
        UPDATE users SET phone = NULL WHERE id = '10000000-0000-4000-8000-000000000003';
      `);
    }).toThrow();
  });
});
