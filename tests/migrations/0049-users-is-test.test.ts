import { describe, expect, it } from 'vitest';

import { makeMigrationDb, runMigration } from '../helpers/migrations';

describe('migration 0049 users is_test guard', () => {
  it('backfills only the two exact seed pairs and remains idempotent', () => {
    const mem = makeMigrationDb();
    mem.public.none(`
      CREATE TABLE users (
        id UUID PRIMARY KEY,
        phone TEXT NOT NULL UNIQUE
      );

      INSERT INTO users (id, phone) VALUES
        ('00000000-0000-0000-0000-000000000001', '+8613800000001'),
        ('00000000-0000-0000-0000-000000000002', '+8613800000002'),
        ('00000000-0000-0000-0000-0000000000ff', '+8613800000009');
    `);

    runMigration(mem, 'db/migrations/0049-add-users-is-test.sql');
    runMigration(mem, 'db/migrations/0049-add-users-is-test.sql');

    expect(mem.public.many(`SELECT id::text, is_test FROM users ORDER BY id`)).toEqual([
      {
        id: '00000000-0000-0000-0000-000000000001',
        is_test: true,
      },
      {
        id: '00000000-0000-0000-0000-000000000002',
        is_test: true,
      },
      {
        id: '00000000-0000-0000-0000-0000000000ff',
        is_test: false,
      },
    ]);
  });

  it('does not backfill rows where only the seed ID or phone matches', () => {
    const mem = makeMigrationDb();
    mem.public.none(`
      CREATE TABLE users (
        id UUID PRIMARY KEY,
        phone TEXT NOT NULL UNIQUE
      );

      INSERT INTO users (id, phone) VALUES
        ('00000000-0000-0000-0000-000000000001', '+8613812345678'),
        ('10000000-0000-4000-8000-000000000002', '+8613800000002');
    `);

    runMigration(mem, 'db/migrations/0049-add-users-is-test.sql');

    expect(mem.public.many(`SELECT id::text, is_test FROM users ORDER BY id`)).toEqual([
      {
        id: '00000000-0000-0000-0000-000000000001',
        is_test: false,
      },
      {
        id: '10000000-0000-4000-8000-000000000002',
        is_test: false,
      },
    ]);
  });
});
