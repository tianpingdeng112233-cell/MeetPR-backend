import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app';
import { createDb } from '../../src/db/kysely';
import { createPool } from '../../src/db/pool';
import { auth, config, signToken } from '../helpers/bindEval';
import { makeMigrationDb } from '../helpers/migrations';

const migration = () => fs.readFileSync('db/migrations/0071-body-weight-records.sql', 'utf8');
const student = '10000000-0000-4000-8000-000000000001';

// pg-mem cannot execute AT TIME ZONE / pg_timezone_names. Exercise the exact
// table DDL here; the unmodified full migration is tested on opt-in local PG17 below.
function tableSql() {
  const ddl = migration().split('-- Backfill')[0];
  if (!ddl) throw new Error('Missing migration DDL');
  return ddl;
}

function setup() {
  const mem = makeMigrationDb();
  mem.public.none(`CREATE TABLE users (id UUID PRIMARY KEY);
    INSERT INTO users VALUES ('${student}');`);
  mem.public.none(tableSql());
  return mem;
}

describe('migration 0071 table', () => {
  it('creates an empty table and permits one record per user and date', () => {
    const mem = setup();
    expect(mem.public.many('SELECT * FROM body_weight_records')).toEqual([]);
    mem.public.none(`INSERT INTO body_weight_records (user_id, recorded_on, weight_kg)
      VALUES ('${student}', '2026-10-09', 83.25)`);
    expect(() => {
      mem.public.none(`INSERT INTO body_weight_records (user_id, recorded_on, weight_kg)
      VALUES ('${student}', '2026-10-09', 84)`);
    }).toThrow(/unique|duplicate/i);
  });

  it.each([0, -1, 500])('rejects out-of-range weight %s', (weight) => {
    const mem = setup();
    expect(() => {
      mem.public.none(`INSERT INTO body_weight_records (user_id, recorded_on, weight_kg)
      VALUES ('${student}', '2026-10-09', ${String(weight)})`);
    }).toThrow(/check|constraint/i);
  });

  it('cascades records when the user is deleted', () => {
    const mem = setup();
    mem.public.none(`INSERT INTO body_weight_records (user_id, recorded_on, weight_kg)
      VALUES ('${student}', '2026-10-09', 83);
      DELETE FROM users WHERE id = '${student}'`);
    expect(mem.public.many('SELECT * FROM body_weight_records')).toEqual([]);
  });
});

// Explicit local Unix socket only: never consume DATABASE_URL or any .env.
// With isolated PG17 listening in "$PWD/pg17-socket", run:
// BODY_WEIGHT_PG17_SOCKET="$PWD/pg17-socket" pnpm exec vitest run tests/migrations/0071-body-weight-records.test.ts
// Optionally add BODY_WEIGHT_PG17_USER=<role>; the default database role is postgres.
const socket = process.env.BODY_WEIGHT_PG17_SOCKET;
const schema = `body_weight_0071_${randomUUID().replaceAll('-', '')}`;

describe.skipIf(!socket)('migration 0071 on local PostgreSQL 17', () => {
  let pool: Pool;
  let closePool: (() => Promise<void>) | undefined;
  let admin: Pool | undefined;
  beforeAll(async () => {
    if (!socket || !path.resolve(socket).startsWith(`${process.cwd()}${path.sep}`)) {
      throw new Error('BODY_WEIGHT_PG17_SOCKET must be inside this worktree');
    }
    // pg lets connection-string fields override Pool options, so encode both
    // socket and role in the shared connection string rather than mixing them.
    const connectionString = `postgresql:///postgres?${new URLSearchParams({
      host: path.resolve(socket),
      user: process.env.BODY_WEIGHT_PG17_USER ?? 'postgres',
    }).toString()}`;
    admin = new Pool({ connectionString, max: 1 });
    const version = await admin.query<{ server_version_num: string }>('SHOW server_version_num');
    expect(Number(version.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(170000);
    expect(Number(version.rows[0]?.server_version_num)).toBeLessThan(180000);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = createPool(connectionString, {
      options: `-c search_path=${schema}`,
      max: 1,
    });
    closePool = () => pool.end();
  });
  afterAll(async () => {
    await closePool?.();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
  beforeEach(async () => {
    await pool.query(`DROP TABLE IF EXISTS body_weight_records, onboarding_uploads, student_onboarding_profiles, users CASCADE;
      CREATE TABLE users (id UUID PRIMARY KEY, timezone TEXT NOT NULL);
      INSERT INTO users VALUES
        ('${student}', 'Asia/Shanghai'),
        ('10000000-0000-4000-8000-000000000002', 'America/Los_Angeles'),
        ('10000000-0000-4000-8000-000000000003', 'Not/AZone'),
        ('10000000-0000-4000-8000-000000000004', 'UTC');`);
    await pool.query(fs.readFileSync('db/migrations/0013-init-onboarding-profiles.sql', 'utf8'));
  });

  async function seedProfiles() {
    await pool.query(`INSERT INTO student_onboarding_profiles (user_id, weight_kg, updated_at)
      VALUES ('${student}', 83.25, '2026-10-08T18:30:00Z'),
      ('10000000-0000-4000-8000-000000000002', 84, '2026-10-09T02:30:00Z'),
      ('10000000-0000-4000-8000-000000000003', 85, '2026-10-08T18:30:00Z'),
      ('10000000-0000-4000-8000-000000000004', NULL, '2026-10-08T18:30:00Z')`);
  }

  it('applies the full migration to a clean database', async () => {
    await pool.query(migration());
    expect((await pool.query('SELECT * FROM body_weight_records')).rows).toEqual([]);
  });

  it('backfills by each user timezone, falls back to UTC, skips nulls and preserves every profile', async () => {
    await seedProfiles();
    const before = (await pool.query('SELECT * FROM student_onboarding_profiles ORDER BY user_id'))
      .rows;
    await pool.query(migration());
    expect(
      (await pool.query('SELECT * FROM student_onboarding_profiles ORDER BY user_id')).rows,
    ).toEqual(before);
    expect(
      (
        await pool.query(
          'SELECT recorded_on::text, weight_kg, created_at, updated_at FROM body_weight_records ORDER BY user_id',
        )
      ).rows,
    ).toEqual([
      {
        recorded_on: '2026-10-09',
        weight_kg: '83.25',
        created_at: new Date('2026-10-08T18:30:00Z'),
        updated_at: new Date('2026-10-08T18:30:00Z'),
      },
      {
        recorded_on: '2026-10-08',
        weight_kg: '84.00',
        created_at: new Date('2026-10-09T02:30:00Z'),
        updated_at: new Date('2026-10-09T02:30:00Z'),
      },
      {
        recorded_on: '2026-10-08',
        weight_kg: '85.00',
        created_at: new Date('2026-10-08T18:30:00Z'),
        updated_at: new Date('2026-10-08T18:30:00Z'),
      },
    ]);
  });

  it('reruns without duplicates or overwriting an existing record', async () => {
    await seedProfiles();
    await pool.query(migration());
    await pool.query(`UPDATE body_weight_records SET weight_kg = 90 WHERE user_id = '${student}'`);
    const before = (await pool.query('SELECT * FROM body_weight_records ORDER BY user_id')).rows;
    await pool.query(migration());
    expect((await pool.query('SELECT * FROM body_weight_records ORDER BY user_id')).rows).toEqual(
      before,
    );
  });

  it('does not backfill again after a profile timestamp moves to another calendar day', async () => {
    await seedProfiles();
    await pool.query(migration());
    const before = (
      await pool.query('SELECT * FROM body_weight_records ORDER BY user_id, recorded_on')
    ).rows;
    await pool.query(
      `UPDATE student_onboarding_profiles SET updated_at = '2026-10-12T18:30:00Z' WHERE user_id = '${student}'`,
    );
    await pool.query(migration());
    expect(
      (await pool.query('SELECT * FROM body_weight_records ORDER BY user_id, recorded_on')).rows,
    ).toEqual(before);
  });

  it('preserves the old user first profile screen and exposes exactly one backfilled record', async () => {
    await seedProfiles();
    const app = createApp({ config, logger: pino({ level: 'silent' }), db: createDb(pool) });
    const token = signToken(student, 'coached_student');
    const before = await request(app).get(`/students/${student}/onboarding`).set(auth(token));
    expect(before.status).toBe(200);
    await pool.query(migration());
    const after = await request(app).get(`/students/${student}/onboarding`).set(auth(token));
    expect(after.status).toBe(200);
    expect(after.body).toEqual(before.body);
    const records = await request(app).get('/students/me/body-weights').set(auth(token));
    expect(records.status).toBe(200);
    expect(records.body).toEqual({ records: [{ recorded_on: '2026-10-09', weight_kg: '83.25' }] });
  });
});
