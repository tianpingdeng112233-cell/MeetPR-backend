import bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import jwt, { type SignOptions } from 'jsonwebtoken';
import type { Kysely } from 'kysely';
import { DataType, newDb } from 'pg-mem';
import pino from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/app';
import type { Config } from '../../src/config';
import { createDb } from '../../src/db/kysely';
import type { Database, UserRole } from '../../src/db/types';

const authConfig: Config = {
  NODE_ENV: 'test',
  PORT: 3000,
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  JWT_ACCESS_SECRET: 'access-secret-for-auth-tests-minimum-length-32',
  JWT_REFRESH_SECRET: 'refresh-secret-for-auth-tests-minimum-length-32',
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_TTL: '30d',
  LOG_LEVEL: 'silent',
  RATE_LIMIT_WINDOW_MS: 60_000,
  RATE_LIMIT_MAX: 10_000,
  CORS_ORIGIN: '*',
  EVENTS_RATE_LIMIT_WINDOW_MS: 60_000,
  EVENTS_RATE_LIMIT_MAX: 10_000,
  ANALYTICS_ENABLED: true,
  SIGNALS_CRON_ENABLED: true,
  PUSH_ENABLED: false,
  PUSH_DAILY_DIGEST_ENABLED: false,
  ANALYTICS_SAMPLE_RATE: 1,
  TRUST_PROXY: 0,
};

interface UserRecord {
  id: string;
  phone: string;
  apple_user_id: string | null;
  password_hash: string;
  role: UserRole;
  refresh_token_jti: string | null;
  created_at: Date;
  updated_at: Date;
}

interface SessionRecord {
  id: string;
  user_id: string;
  refresh_token_jti: string;
  prev_jti: string | null;
  prev_jti_valid_until: Date | null;
  created_at: Date;
  last_used_at: Date;
  revoked_at: Date | null;
}

class InMemoryAuthDb {
  private readonly mem = newDb();
  private readonly db: Kysely<Database>;
  private sessionsMigrationApplied = false;

  constructor(options: { applySessionsMigration?: boolean } = {}) {
    this.mem.public.registerFunction({
      name: 'gen_random_uuid',
      returns: DataType.uuid,
      impure: true,
      implementation: randomUUID,
    });
    this.mem.public.none(fs.readFileSync('db/migrations/0001-init-users.sql', 'utf8'));
    if (options.applySessionsMigration !== false) this.applySessionsMigration();

    const { Pool } = this.mem.adapters.createPg();
    this.db = createDb(new Pool());
  }

  asKysely(): Kysely<Database> {
    return this.db;
  }

  getByPhone(phone: string): UserRecord | undefined {
    return (this.mem.public.many('SELECT * FROM users') as UserRecord[]).find(
      (user) => user.phone === phone,
    );
  }

  getSessions(userId: string): SessionRecord[] {
    return (this.mem.public.many('SELECT * FROM sessions') as SessionRecord[])
      .filter((session) => session.user_id === userId)
      .sort((left, right) => left.created_at.getTime() - right.created_at.getTime());
  }

  getSessionByCurrentJti(jti: string): SessionRecord | undefined {
    return (this.mem.public.many('SELECT * FROM sessions') as SessionRecord[]).find(
      (session) => session.refresh_token_jti === jti,
    );
  }

  expirePreviousJti(jti: string): void {
    this.mem.public.none(
      `UPDATE sessions SET prev_jti_valid_until = '2000-01-01T00:00:00Z' WHERE prev_jti = '${jti}'`,
    );
  }

  makeSessionOld(jti: string): void {
    this.mem.public.none(
      `UPDATE sessions SET last_used_at = '2000-01-01T00:00:00Z' WHERE refresh_token_jti = '${jti}'`,
    );
  }

  insertLegacyUser(user: Pick<UserRecord, 'id' | 'phone' | 'role' | 'refresh_token_jti'>): void {
    this.mem.public.none(`
      INSERT INTO users (id, phone, password_hash, role, refresh_token_jti)
      VALUES (
        '${user.id}',
        '${user.phone}',
        'legacy-password-hash',
        '${user.role}',
        ${user.refresh_token_jti === null ? 'NULL' : `'${user.refresh_token_jti}'`}
      )
    `);
  }

  applySessionsMigration(): void {
    if (this.sessionsMigrationApplied) return;
    this.mem.public.none(fs.readFileSync('db/migrations/0039-multi-device-sessions.sql', 'utf8'));
    this.sessionsMigrationApplied = true;
  }
}

function makeApp(logger = pino({ level: 'silent' }), config: Config = authConfig) {
  const db = new InMemoryAuthDb();
  const app = createApp({ config, logger, db: db.asKysely() });
  return { app, db };
}

function verifyAccessToken(token: string) {
  return jwt.verify(token, authConfig.JWT_ACCESS_SECRET);
}

function refreshJti(token: string): string {
  const payload = jwt.verify(token, authConfig.JWT_REFRESH_SECRET);
  if (typeof payload !== 'string' && typeof payload.jti === 'string') {
    return payload.jti;
  }
  throw new Error('refresh token missing jti');
}

async function registerUser(phone = '+8613800000001') {
  const { app, db } = makeApp();
  const response = await request(app).post('/auth/register').send({
    phone,
    password: 'hunter2hunter2',
    role: 'coach',
  });
  return { app, db, response };
}

describe('auth endpoints', () => {
  it('registers a user and returns the public user plus tokens', async () => {
    const { db, response } = await registerUser();

    expect(response.status).toBe(201);
    expect(response.body.user).toMatchObject({
      phone: '+8613800000001',
      role: 'coach',
    });
    expect(typeof response.body.user.id).toBe('string');
    expect(typeof response.body.user.createdAt).toBe('string');
    expect(typeof response.body.accessToken).toBe('string');
    expect(typeof response.body.refreshToken).toBe('string');

    const row = db.getByPhone('+8613800000001');
    expect(row).toBeDefined();
    expect(row?.password_hash).toMatch(/^\$2[ayb]\$10\$/);
    await expect(bcrypt.compare('hunter2hunter2', row?.password_hash ?? '')).resolves.toBe(true);
    expect(row?.refresh_token_jti).toBeNull();

    const issuedJti = refreshJti(response.body.refreshToken as string);
    expect(issuedJti).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(db.getSessionByCurrentJti(issuedJti)).toMatchObject({
      user_id: row?.id,
      revoked_at: null,
    });

    const accessPayload = verifyAccessToken(response.body.accessToken as string);
    expect(accessPayload).toMatchObject({
      sub: response.body.user.id,
      role: 'coach',
    });
  });

  it('rejects duplicate phone registration with AUTH_PHONE_TAKEN', async () => {
    const { app } = await registerUser();
    const response = await request(app).post('/auth/register').send({
      phone: '+8613800000001',
      password: 'hunter2hunter2',
      role: 'coach',
    });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'AUTH_PHONE_TAKEN' });
  });

  it.each([
    ['too short', 'short'],
    ['more than 72 ASCII bytes', 'a'.repeat(73)],
    ['more than 72 UTF-8 bytes', '密'.repeat(25)],
  ])('rejects register password validation: %s', async (_caseName, password) => {
    const { app } = makeApp();
    const response = await request(app).post('/auth/register').send({
      phone: '+8613800000001',
      password,
      role: 'coach',
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('VALIDATION_ERROR');
    expect(response.body.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['password'] })]),
    );
  });

  it('rejects an invalid role during registration', async () => {
    const { app } = makeApp();
    const response = await request(app).post('/auth/register').send({
      phone: '+8613800000001',
      password: 'hunter2hunter2',
      role: 'admin',
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('VALIDATION_ERROR');
    expect(response.body.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['role'] })]),
    );
  });

  it('rejects a non-E.164 phone during registration', async () => {
    const { app } = makeApp();
    const response = await request(app).post('/auth/register').send({
      phone: '13800000000',
      password: 'hunter2hunter2',
      role: 'coach',
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('VALIDATION_ERROR');
    expect(response.body.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['phone'] })]),
    );
  });

  it('closes production registration by default and never permits coach self-registration', async () => {
    const productionConfig: Config = {
      ...authConfig,
      NODE_ENV: 'production',
      CORS_ORIGIN: 'https://plan.example.test',
      TRUST_PROXY: 1,
      PUBLIC_BASE_URL: 'https://api.example.test',
    };
    const closed = makeApp(undefined, productionConfig);
    const closedResponse = await request(closed.app)
      .post('/auth/register')
      .set('X-Forwarded-Proto', 'https')
      .send({ phone: '+8613800000001', password: 'hunter2hunter2', role: 'coached_student' });
    expect(closedResponse.status).toBe(403);
    expect(closedResponse.body).toEqual({ error: 'AUTH_REGISTRATION_DISABLED' });

    const allowlisted = makeApp(undefined, {
      ...productionConfig,
      REGISTRATION_ENABLED: true,
      REGISTRATION_ALLOWLIST: '+8613800000001',
    });
    const coachResponse = await request(allowlisted.app)
      .post('/auth/register')
      .set('X-Forwarded-Proto', 'https')
      .send({ phone: '+8613800000001', password: 'hunter2hunter2', role: 'coach' });
    expect(coachResponse.status).toBe(403);
    expect(coachResponse.body).toEqual({ error: 'AUTH_REGISTRATION_NOT_ALLOWED' });
  });

  it('logs in with a valid phone and password', async () => {
    const { app, db, response: registerResponse } = await registerUser();
    const registerJti = refreshJti(registerResponse.body.refreshToken as string);

    const response = await request(app).post('/auth/login').send({
      phone: '+8613800000001',
      password: 'hunter2hunter2',
    });

    expect(response.status).toBe(200);
    expect(response.body.user.phone).toBe('+8613800000001');
    expect(typeof response.body.accessToken).toBe('string');
    expect(typeof response.body.refreshToken).toBe('string');
    const loginJti = refreshJti(response.body.refreshToken as string);
    expect(loginJti).not.toBe(registerJti);
    expect(db.getSessionByCurrentJti(registerJti)?.revoked_at).toBeNull();
    expect(db.getSessionByCurrentJti(loginJti)?.revoked_at).toBeNull();
  });

  it('keeps two device sessions independent while each rotates', async () => {
    const { app, db, response: firstDevice } = await registerUser();
    const secondDevice = await request(app).post('/auth/login').send({
      phone: '+8613800000001',
      password: 'hunter2hunter2',
    });
    expect(secondDevice.status).toBe(200);

    const firstRefresh = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: firstDevice.body.refreshToken });
    const secondRefresh = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: secondDevice.body.refreshToken });

    expect(firstRefresh.status).toBe(200);
    expect(secondRefresh.status).toBe(200);
    const user = db.getByPhone('+8613800000001');
    expect(
      db.getSessions(user?.id ?? '').filter((session) => session.revoked_at === null),
    ).toHaveLength(2);
  });

  it('caps active sessions at five and revokes the least recently used', async () => {
    const { app, db, response: registration } = await registerUser();
    const oldestJti = refreshJti(registration.body.refreshToken as string);
    db.makeSessionOld(oldestJti);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await request(app).post('/auth/login').send({
        phone: '+8613800000001',
        password: 'hunter2hunter2',
      });
      expect(response.status).toBe(200);
    }

    const user = db.getByPhone('+8613800000001');
    const sessions = db.getSessions(user?.id ?? '');
    expect(sessions.filter((session) => session.revoked_at === null)).toHaveLength(5);
    expect(db.getSessionByCurrentJti(oldestJti)?.revoked_at).toBeInstanceOf(Date);
  });

  it('rejects login with a wrong password without revealing phone existence', async () => {
    const { app } = await registerUser();
    const response = await request(app).post('/auth/login').send({
      phone: '+8613800000001',
      password: 'wrong-password',
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'AUTH_INVALID_CREDENTIALS' });
  });

  it('rejects login for a non-existent phone with the same credentials error', async () => {
    const { app } = makeApp();
    const response = await request(app).post('/auth/login').send({
      phone: '+8613800000099',
      password: 'wrong-password',
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'AUTH_INVALID_CREDENTIALS' });
  });

  it('refreshes tokens and rotates the stored jti', async () => {
    const { app, db, response: registerResponse } = await registerUser();
    const oldRefreshToken = registerResponse.body.refreshToken as string;
    const oldJti = refreshJti(oldRefreshToken);

    const response = await request(app).post('/auth/refresh').send({
      refreshToken: oldRefreshToken,
    });

    expect(response.status).toBe(200);
    expect(typeof response.body.accessToken).toBe('string');
    expect(typeof response.body.refreshToken).toBe('string');
    const newJti = refreshJti(response.body.refreshToken as string);
    expect(newJti).not.toBe(oldJti);
    expect(db.getSessionByCurrentJti(newJti)).toMatchObject({ prev_jti: oldJti });
  });

  it('accepts the snake_case refresh_token key sent by the shipped iOS client', async () => {
    const { app, db, response: registerResponse } = await registerUser();
    const oldRefreshToken = registerResponse.body.refreshToken as string;
    const oldJti = refreshJti(oldRefreshToken);

    const response = await request(app).post('/auth/refresh').send({
      refresh_token: oldRefreshToken,
    });

    expect(response.status).toBe(200);
    expect(typeof response.body.accessToken).toBe('string');
    expect(typeof response.body.refreshToken).toBe('string');
    const newJti = refreshJti(response.body.refreshToken as string);
    expect(newJti).not.toBe(oldJti);
    expect(db.getSessionByCurrentJti(newJti)).toMatchObject({ prev_jti: oldJti });
  });

  it('prefers refreshToken when both key spellings are present', async () => {
    const { app, response: registerResponse } = await registerUser();
    const validRefreshToken = registerResponse.body.refreshToken as string;

    const response = await request(app).post('/auth/refresh').send({
      refreshToken: validRefreshToken,
      refresh_token: 'garbage',
    });

    expect(response.status).toBe(200);
    expect(typeof response.body.accessToken).toBe('string');
  });

  it('rejects a refresh body with neither refreshToken nor refresh_token', async () => {
    const { app } = makeApp();
    const response = await request(app).post('/auth/refresh').send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('VALIDATION_ERROR');
  });

  it('retries the previous jti idempotently in grace, then revokes only that session outside it', async () => {
    const { app, db, response: registerResponse } = await registerUser();
    const oldRefreshToken = registerResponse.body.refreshToken as string;
    const oldJti = refreshJti(oldRefreshToken);
    const otherDevice = await request(app).post('/auth/login').send({
      phone: '+8613800000001',
      password: 'hunter2hunter2',
    });
    expect(otherDevice.status).toBe(200);

    const firstRefresh = await request(app).post('/auth/refresh').send({
      refreshToken: oldRefreshToken,
    });
    expect(firstRefresh.status).toBe(200);
    const currentJti = refreshJti(firstRefresh.body.refreshToken as string);

    const graceRetry = await request(app).post('/auth/refresh').send({
      refreshToken: oldRefreshToken,
    });
    expect(graceRetry.status).toBe(200);
    expect(refreshJti(graceRetry.body.refreshToken as string)).toBe(currentJti);
    expect(db.getSessionByCurrentJti(currentJti)?.prev_jti).toBe(oldJti);

    db.expirePreviousJti(oldJti);
    const staleRetry = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: oldRefreshToken });
    expect(staleRetry.status).toBe(401);
    expect(staleRetry.body).toEqual({ error: 'AUTH_INVALID_REFRESH' });
    expect(db.getSessionByCurrentJti(currentJti)?.revoked_at).toBeInstanceOf(Date);

    const otherDeviceRefresh = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: otherDevice.body.refreshToken });
    expect(otherDeviceRefresh.status).toBe(200);
  });

  it('rejects an expired refresh token with AUTH_REFRESH_EXPIRED', async () => {
    const { app, db } = await registerUser();
    const user = db.getByPhone('+8613800000001');
    const session = db.getSessions(user?.id ?? '')[0];
    const expiredToken = jwt.sign(
      { sub: user?.id, role: 'coach', jti: session?.refresh_token_jti, typ: 'refresh' },
      authConfig.JWT_REFRESH_SECRET,
      {
        algorithm: 'HS256',
        expiresIn: -1,
        issuer: 'meetpr-api',
        audience: 'meetpr-client',
      } satisfies SignOptions,
    );

    const response = await request(app).post('/auth/refresh').send({
      refreshToken: expiredToken,
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'AUTH_REFRESH_EXPIRED' });
  });

  it('rejects a malformed refresh token with AUTH_INVALID_REFRESH', async () => {
    const { app } = makeApp();
    const response = await request(app).post('/auth/refresh').send({
      refreshToken: 'garbage',
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'AUTH_INVALID_REFRESH' });
  });

  it('does not write passwords or tokens to auth log lines', async () => {
    const logLines: string[] = [];
    const sink = {
      write(line: string): void {
        logLines.push(line);
      },
    };
    const logger = pino({ level: 'info', base: null }, sink);
    const { app } = makeApp(logger);
    const password = 'secret-password-123';

    const response = await request(app).post('/auth/register').send({
      phone: '+8613800000101',
      password,
      role: 'coach',
    });

    expect(response.status).toBe(201);
    const joinedLogs = logLines.join('\n');
    expect(joinedLogs).not.toContain(password);
    expect(joinedLogs).not.toContain(response.body.accessToken);
    expect(joinedLogs).not.toContain(response.body.refreshToken);
  });

  it('allows a valid access token through requireAuth middleware', async () => {
    const { app } = makeApp();
    const accessToken = jwt.sign(
      { sub: 'user_test_1', role: 'coach', typ: 'access' },
      authConfig.JWT_ACCESS_SECRET,
      {
        algorithm: 'HS256',
        expiresIn: '15m',
        issuer: 'meetpr-api',
        audience: 'meetpr-client',
      } satisfies SignOptions,
    );

    // Empty body → 400 from the real route: proof the token cleared
    // requireAuth (spec 011 replaced the old GET /me 501 stub).
    const response = await request(app)
      .put('/me/password')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({});

    expect(response.status).toBe(400);
  });

  it('rejects a refresh-shaped token at an access-protected route even if it is signed by the access key', async () => {
    const { app } = makeApp();
    const refreshShapedToken = jwt.sign(
      { sub: 'user_test_1', role: 'coach', jti: randomUUID(), typ: 'refresh' },
      authConfig.JWT_ACCESS_SECRET,
      {
        algorithm: 'HS256',
        expiresIn: '15m',
        issuer: 'meetpr-api',
        audience: 'meetpr-client',
      } satisfies SignOptions,
    );

    const response = await request(app)
      .get('/me')
      .set('Authorization', `Bearer ${refreshShapedToken}`);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'AUTH_INVALID_TOKEN' });
  });

  it('rejects an invalid access token in requireAuth middleware', async () => {
    const { app } = makeApp();

    const response = await request(app).get('/me').set('Authorization', 'Bearer invalid-token');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'AUTH_INVALID_TOKEN' });
  });

  it('accepts a legacy access token lacking aud/iss when legacy grace is enabled', async () => {
    const { app } = makeApp();
    const legacyToken = jwt.sign(
      { sub: 'user_test_1', role: 'coach' },
      authConfig.JWT_ACCESS_SECRET,
      { algorithm: 'HS256', expiresIn: '15m' } satisfies SignOptions,
    );

    // Empty body → 400 from the real route: proof the legacy token cleared
    // requireAuth (spec 011 replaced the old GET /me 501 stub). A rejected
    // token would 401 before ever reaching validation.
    const response = await request(app)
      .put('/me/password')
      .set('Authorization', `Bearer ${legacyToken}`)
      .send({});

    expect(response.status).toBe(400);
  });

  it('rejects a legacy access token when AUTH_ALLOW_LEGACY_TOKENS is false', async () => {
    const { app } = makeApp(undefined, { ...authConfig, AUTH_ALLOW_LEGACY_TOKENS: false });
    const legacyToken = jwt.sign(
      { sub: 'user_test_1', role: 'coach' },
      authConfig.JWT_ACCESS_SECRET,
      { algorithm: 'HS256', expiresIn: '15m' } satisfies SignOptions,
    );

    const response = await request(app).get('/me').set('Authorization', `Bearer ${legacyToken}`);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'AUTH_INVALID_TOKEN' });
  });

  it('backfills an existing users jti and refreshes its pre-migration token without logout', async () => {
    const db = new InMemoryAuthDb({ applySessionsMigration: false });
    const userId = randomUUID();
    const oldJti = randomUUID();
    db.insertLegacyUser({
      id: userId,
      phone: '+8613800000001',
      role: 'coach',
      refresh_token_jti: oldJti,
    });
    const preMigrationRefresh = jwt.sign(
      { sub: userId, role: 'coach', jti: oldJti, typ: 'refresh' },
      authConfig.JWT_REFRESH_SECRET,
      {
        algorithm: 'HS256',
        expiresIn: '30d',
        issuer: 'meetpr-api',
        audience: 'meetpr-client',
      } satisfies SignOptions,
    );
    db.applySessionsMigration();
    const app = createApp({
      config: authConfig,
      logger: pino({ level: 'silent' }),
      db: db.asKysely(),
    });

    expect(db.getSessionByCurrentJti(oldJti)).toMatchObject({ user_id: userId });
    const response = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: preMigrationRefresh });

    expect(response.status).toBe(200);
    expect(refreshJti(response.body.refreshToken as string)).not.toBe(oldJti);
  });

  it('creates a missing session for a valid legacy refresh token and re-issues full claims', async () => {
    const db = new InMemoryAuthDb();
    const userId = randomUUID();
    const oldJti = randomUUID();
    db.insertLegacyUser({
      id: userId,
      phone: '+8613800000001',
      role: 'coach',
      refresh_token_jti: oldJti,
    });
    const app = createApp({
      config: authConfig,
      logger: pino({ level: 'silent' }),
      db: db.asKysely(),
    });
    const legacyRefresh = jwt.sign(
      { sub: userId, role: 'coach', jti: oldJti },
      authConfig.JWT_REFRESH_SECRET,
      { algorithm: 'HS256', expiresIn: '30d' } satisfies SignOptions,
    );

    const response = await request(app).post('/auth/refresh').send({ refreshToken: legacyRefresh });

    expect(response.status).toBe(200);
    expect(typeof response.body.refreshToken).toBe('string');
    // The re-issued token verifies under the strict aud/iss path, so the holder
    // migrates forward on this refresh; the newly created session is rotated.
    const newJti = refreshJti(response.body.refreshToken as string);
    expect(newJti).not.toBe(oldJti);
    expect(db.getSessionByCurrentJti(newJti)).toMatchObject({
      user_id: userId,
      prev_jti: oldJti,
      revoked_at: null,
    });
  });

  it('rejects a rotated legacy token without creating a session', async () => {
    const db = new InMemoryAuthDb();
    const userId = randomUUID();
    const revokedJti = randomUUID();
    const currentJti = randomUUID();
    db.insertLegacyUser({
      id: userId,
      phone: '+8613800000001',
      role: 'coach',
      refresh_token_jti: currentJti,
    });
    const app = createApp({
      config: authConfig,
      logger: pino({ level: 'silent' }),
      db: db.asKysely(),
    });
    const revokedLegacyRefresh = jwt.sign(
      { sub: userId, role: 'coach', jti: revokedJti },
      authConfig.JWT_REFRESH_SECRET,
      { algorithm: 'HS256', expiresIn: '30d' } satisfies SignOptions,
    );

    const response = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: revokedLegacyRefresh });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'AUTH_INVALID_REFRESH' });
    expect(db.getSessions(userId)).toHaveLength(0);
  });

  it('retries a backfilled legacy token without creating another session', async () => {
    const db = new InMemoryAuthDb();
    const userId = randomUUID();
    const oldJti = randomUUID();
    db.insertLegacyUser({
      id: userId,
      phone: '+8613800000001',
      role: 'coach',
      refresh_token_jti: oldJti,
    });
    const app = createApp({
      config: authConfig,
      logger: pino({ level: 'silent' }),
      db: db.asKysely(),
    });
    const legacyRefresh = jwt.sign(
      { sub: userId, role: 'coach', jti: oldJti },
      authConfig.JWT_REFRESH_SECRET,
      { algorithm: 'HS256', expiresIn: '30d' } satisfies SignOptions,
    );

    const firstResponse = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: legacyRefresh });
    expect(firstResponse.status).toBe(200);
    const firstJti = refreshJti(firstResponse.body.refreshToken as string);
    expect(db.getSessions(userId)).toHaveLength(1);

    const retryResponse = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: legacyRefresh });

    expect(retryResponse.status).toBe(200);
    expect(refreshJti(retryResponse.body.refreshToken as string)).toBe(firstJti);
    expect(db.getSessions(userId)).toHaveLength(1);
  });

  it('rejects a legacy refresh token when AUTH_ALLOW_LEGACY_TOKENS is false', async () => {
    const { app, db } = makeApp(undefined, { ...authConfig, AUTH_ALLOW_LEGACY_TOKENS: false });
    const registerResponse = await request(app)
      .post('/auth/register')
      .send({ phone: '+8613800000001', password: 'hunter2hunter2', role: 'coach' });
    expect(registerResponse.status).toBe(201);
    const stored = db.getByPhone('+8613800000001');
    const currentJti = refreshJti(registerResponse.body.refreshToken as string);
    const legacyRefresh = jwt.sign(
      { sub: stored?.id, role: stored?.role, jti: currentJti },
      authConfig.JWT_REFRESH_SECRET,
      { algorithm: 'HS256', expiresIn: '30d' } satisfies SignOptions,
    );

    const response = await request(app).post('/auth/refresh').send({ refreshToken: legacyRefresh });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'AUTH_INVALID_REFRESH' });
  });
});
