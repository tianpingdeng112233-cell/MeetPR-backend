import bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { DataType, newDb } from 'pg-mem';
import { describe, expect, it } from 'vitest';

import { provisionCoach } from '../scripts/provision-coach-global';
import { createDb } from '../src/db/kysely';

function makeDb() {
  const mem = newDb();
  mem.public.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.uuid,
    impure: true,
    implementation: randomUUID,
  });
  for (const file of [
    '0001-init-users.sql',
    '0064-global-identity.sql',
    '0066-add-user-timezone.sql',
  ]) {
    mem.public.none(fs.readFileSync(`db/migrations/${file}`, 'utf8'));
  }
  const { Pool } = mem.adapters.createPg();
  return createDb(new Pool());
}

describe('create-only global coach provisioning', () => {
  it('rejects an existing coach without changing its password or identity', async () => {
    const db = makeDb();
    try {
      const original = await db
        .insertInto('users')
        .values({
          phone: null,
          email: 'qa@example.test',
          password_hash: 'unchanged-hash',
          role: 'coach',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await expect(
        provisionCoach(db, {
          email: 'qa@example.test',
          password: 'new-password',
          timezone: 'Europe/London',
        }),
      ).rejects.toThrow('COACH_EMAIL_EXISTS');
      expect(await db.selectFrom('users').selectAll().execute()).toEqual([original]);
      expect(await db.selectFrom('user_identities').selectAll().execute()).toEqual([]);
    } finally {
      await db.destroy();
    }
  });
  it('treats a mixed-case email owned by a student as a collision', async () => {
    const db = makeDb();
    try {
      const original = await db
        .insertInto('users')
        .values({
          phone: null,
          email: 'QA@example.test',
          password_hash: 'student-hash',
          role: 'coached_student',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await expect(
        provisionCoach(db, {
          email: ' qa@example.test ',
          password: 'new-password',
          timezone: 'Europe/London',
        }),
      ).rejects.toThrow('COACH_EMAIL_EXISTS');
      expect(await db.selectFrom('users').selectAll().execute()).toEqual([original]);
    } finally {
      await db.destroy();
    }
  });

  it('creates one coach with a usable password and matching email identity', async () => {
    const db = makeDb();
    try {
      await provisionCoach(db, {
        email: ' QA@example.test ',
        password: 'new-password',
        timezone: 'Europe/London',
      });
      const users = await db.selectFrom('users').selectAll().execute();
      expect(users).toHaveLength(1);
      const user = users[0];
      if (user === undefined) throw new Error('Expected the new coach');
      expect(users[0]).toMatchObject({
        email: 'qa@example.test',
        role: 'coach',
        phone: null,
        timezone: 'Europe/London',
      });
      await expect(bcrypt.compare('new-password', user.password_hash)).resolves.toBe(true);
      expect(
        await db
          .selectFrom('user_identities')
          .select(['user_id', 'provider', 'provider_uid', 'email_at_provider'])
          .execute(),
      ).toEqual([
        {
          user_id: user.id,
          provider: 'email',
          provider_uid: 'qa@example.test',
          email_at_provider: 'qa@example.test',
        },
      ]);
    } finally {
      await db.destroy();
    }
  });
});
