import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import { makeMigrationDb, runMigration } from '../helpers/migrations';

function setup() {
  const mem = makeMigrationDb();
  runMigration(mem, 'db/migrations/0001-init-users.sql');
  runMigration(mem, 'db/migrations/0044-add-admin-role.sql');
  return mem;
}

describe('migration 0044 admin role', () => {
  it('widens the role check and declares the single-admin partial unique index', () => {
    const sql = fs.readFileSync('db/migrations/0044-add-admin-role.sql', 'utf8');

    expect(sql).toContain('ALTER TABLE users DROP CONSTRAINT users_role_check');
    expect(sql).toContain("'self_train_student', 'admin'");
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX users_single_admin_idx\s+ON users \(\(true\)\)\s+WHERE role = 'admin'/,
    );
  });

  it('accepts all existing roles plus one admin and rejects a second admin', () => {
    const mem = setup();
    mem.public.none(`
      INSERT INTO users (phone, password_hash, role) VALUES
        ('+8613800044001', 'hash', 'coach'),
        ('+8613800044002', 'hash', 'coached_student'),
        ('+8613800044003', 'hash', 'self_train_student'),
        ('+8613800044004', 'hash', 'admin');
    `);

    expect(() => {
      mem.public.none(`
        INSERT INTO users (phone, password_hash, role)
        VALUES ('+8613800044005', 'hash', 'admin');
      `);
    }).toThrow(/duplicate key|unique/i);
  });
});
