import bcrypt from 'bcrypt';
import { DataType, newDb } from 'pg-mem';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import { provisionAdmin } from '../scripts/create-admin';
import { createDb } from '../src/db/kysely';

function makeDb() {
  const mem = newDb();
  mem.public.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.uuid,
    impure: true,
    implementation: randomUUID,
  });
  mem.public.none(fs.readFileSync('db/migrations/0001-init-users.sql', 'utf8'));
  mem.public.none(fs.readFileSync('db/migrations/0039-multi-device-sessions.sql', 'utf8'));
  mem.public.none(fs.readFileSync('db/migrations/0044-add-admin-role.sql', 'utf8'));
  const { Pool } = mem.adapters.createPg();
  return { db: createDb(new Pool()), mem };
}

describe('create-admin provisioning', () => {
  it('promotes an existing phone, replaces its password, and revokes every live session', async () => {
    const { db, mem } = makeDb();
    mem.public.none(`
      INSERT INTO users (id, phone, password_hash, role, refresh_token_jti)
      VALUES (
        '10000000-0000-4000-8000-000000004401',
        '+8613800044101',
        'old-hash',
        'coach',
        '20000000-0000-4000-8000-000000004401'
      );
      INSERT INTO sessions (user_id, refresh_token_jti)
      VALUES ('10000000-0000-4000-8000-000000004401', '20000000-0000-4000-8000-000000004402');
    `);

    const result = await provisionAdmin(db, {
      phone: '+8613800044101',
      password: 'new-admin-password',
    });
    const row = mem.public.one(
      `SELECT id, role, password_hash, refresh_token_jti FROM users WHERE phone = '+8613800044101';`,
    );

    expect(result).toEqual({ id: '10000000-0000-4000-8000-000000004401', action: 'promoted' });
    expect(row.role).toBe('admin');
    expect(row.refresh_token_jti).toBeNull();
    expect(row.password_hash).toMatch(/^\$2[ayb]\$10\$/);
    await expect(bcrypt.compare('new-admin-password', row.password_hash as string)).resolves.toBe(
      true,
    );
    const liveSessions = mem.public.one(
      `SELECT count(*) AS count FROM sessions
       WHERE user_id = '10000000-0000-4000-8000-000000004401' AND revoked_at IS NULL;`,
    );
    expect(Number(liveSessions.count)).toBe(0);
    await db.destroy();
  });

  it('treats a re-run for the same admin phone as a password rotation', async () => {
    const { db, mem } = makeDb();
    mem.public.none(`
      INSERT INTO users (id, phone, password_hash, role)
      VALUES ('10000000-0000-4000-8000-000000004404', '+8613800044105', 'old-hash', 'admin');
      INSERT INTO sessions (user_id, refresh_token_jti)
      VALUES ('10000000-0000-4000-8000-000000004404', '20000000-0000-4000-8000-000000004405');
    `);

    const result = await provisionAdmin(db, {
      phone: '+8613800044105',
      password: 'rotated-password',
    });
    const row = mem.public.one(`SELECT password_hash FROM users WHERE phone = '+8613800044105';`);
    const liveSessions = mem.public.one(
      `SELECT count(*) AS count FROM sessions
       WHERE user_id = '10000000-0000-4000-8000-000000004404' AND revoked_at IS NULL;`,
    );

    expect(result).toEqual({ id: '10000000-0000-4000-8000-000000004404', action: 'updated' });
    await expect(bcrypt.compare('rotated-password', row.password_hash as string)).resolves.toBe(
      true,
    );
    expect(Number(liveSessions.count)).toBe(0);
    await db.destroy();
  });

  it('creates a new admin when the phone is not present', async () => {
    const { db, mem } = makeDb();

    const result = await provisionAdmin(db, {
      phone: '+8613800044102',
      password: 'new-admin-password',
    });

    expect(result.action).toBe('created');
    expect(mem.public.one(`SELECT role FROM users WHERE id = '${result.id}';`).role).toBe('admin');
    await db.destroy();
  });

  it('refuses without mutation when any admin already exists', async () => {
    const { db, mem } = makeDb();
    mem.public.none(`
      INSERT INTO users (id, phone, password_hash, role) VALUES
        ('10000000-0000-4000-8000-000000004402', '+8613800044103', 'admin-hash', 'admin'),
        ('10000000-0000-4000-8000-000000004403', '+8613800044104', 'coach-hash', 'coach');
    `);

    await expect(
      provisionAdmin(db, {
        phone: '+8613800044104',
        password: 'new-admin-password',
      }),
    ).rejects.toMatchObject({ code: 'ADMIN_ALREADY_EXISTS' });

    expect(mem.public.one(`SELECT role FROM users WHERE phone = '+8613800044104';`).role).toBe(
      'coach',
    );
    await db.destroy();
  });
});
