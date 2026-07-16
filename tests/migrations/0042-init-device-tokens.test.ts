import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createBaseUsers, makeMigrationDb, runMigration } from '../helpers/migrations';

const COACH = '10000000-0000-4000-8000-000000000001';
const STUDENT = '10000000-0000-4000-8000-000000000003';

function setup() {
  const mem = makeMigrationDb();
  createBaseUsers(mem);
  runMigration(mem, 'db/migrations/0042-init-device-tokens.sql');
  return mem;
}

function migrationSql(): string {
  return fs.readFileSync('db/migrations/0042-init-device-tokens.sql', 'utf8');
}

describe('migration 0042 device tokens', () => {
  it('declares the required columns, token uniqueness, platform check, cascade, and user index', () => {
    const sql = migrationSql();

    expect(sql).toMatch(/user_id\s+UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
    expect(sql).toMatch(/token\s+TEXT NOT NULL/);
    expect(sql).toContain("CHECK (platform = 'ios')");
    expect(sql).toContain('UNIQUE (token)');
    expect(sql).toMatch(/created_at\s+TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
    expect(sql).toMatch(/updated_at\s+TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
    expect(sql).toMatch(/last_seen_at\s+TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
    expect(sql).toMatch(/CREATE INDEX device_tokens_user_id_idx\s+ON device_tokens \(user_id\)/);
  });

  it('enforces token uniqueness and the ios-only platform check', () => {
    const mem = setup();

    mem.public.none(`
      INSERT INTO device_tokens (user_id, token, platform)
      VALUES ('${COACH}', 'a1b2c3', 'ios');
    `);

    expect(() => {
      mem.public.none(`
        INSERT INTO device_tokens (user_id, token, platform)
        VALUES ('${STUDENT}', 'a1b2c3', 'ios');
      `);
    }).toThrow(/duplicate key|unique/i);
    expect(() => {
      mem.public.none(`
        INSERT INTO device_tokens (user_id, token, platform)
        VALUES ('${STUDENT}', 'd4e5f6', 'android');
      `);
    }).toThrow(/check constraint/i);
  });

  it('defaults all timestamps and cascades registrations when a user is deleted', () => {
    const mem = setup();

    mem.public.none(`
      INSERT INTO device_tokens (user_id, token, platform)
      VALUES ('${STUDENT}', 'abcdef', 'ios');
    `);
    const row = mem.public.one(`
      SELECT created_at, updated_at, last_seen_at
      FROM device_tokens
      WHERE user_id = '${STUDENT}';
    `);
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.updated_at).toBeInstanceOf(Date);
    expect(row.last_seen_at).toBeInstanceOf(Date);

    mem.public.none(`DELETE FROM users WHERE id = '${STUDENT}';`);
    expect(mem.public.one(`SELECT COUNT(*)::int AS count FROM device_tokens;`).count).toBe(0);
  });
});
