import bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import type { Kysely } from 'kysely';
import pino from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/app';
import type { Config } from '../../src/config';
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

interface Condition {
  column: keyof UserRecord;
  value: unknown;
}

type RowProjection = Record<string, unknown>;

function projectRow(row: UserRecord, selections: readonly string[]): RowProjection {
  const projected: RowProjection = {};
  for (const selection of selections) {
    projected[selection] = row[selection as keyof UserRecord];
  }
  return projected;
}

class SelectBuilder {
  private selections: string[] = [];
  private conditions: Condition[] = [];

  constructor(private readonly db: InMemoryAuthDb) {}

  select(selection: readonly string[] | string): this {
    this.selections = typeof selection === 'string' ? [selection] : [...selection];
    return this;
  }

  where(column: string, _operator: string, value: unknown): this {
    this.conditions.push({ column: column as keyof UserRecord, value });
    return this;
  }

  executeTakeFirst(): Promise<RowProjection | undefined> {
    const row = this.db.find(this.conditions);
    if (!row) return Promise.resolve(undefined);
    return Promise.resolve(projectRow(row, this.selections));
  }
}

class InsertBuilder {
  private valuesToInsert: RowProjection = {};
  private selections: string[] = [];

  constructor(private readonly db: InMemoryAuthDb) {}

  values(values: RowProjection): this {
    this.valuesToInsert = values;
    return this;
  }

  returning(selection: readonly string[]): this {
    this.selections = [...selection];
    return this;
  }

  executeTakeFirstOrThrow(): Promise<RowProjection> {
    const row = this.db.insert(this.valuesToInsert);
    return Promise.resolve(projectRow(row, this.selections));
  }
}

class UpdateBuilder {
  private patch: RowProjection = {};
  private conditions: Condition[] = [];
  private selections: string[] = [];

  constructor(private readonly db: InMemoryAuthDb) {}

  set(patch: RowProjection): this {
    this.patch = patch;
    return this;
  }

  where(column: string, _operator: string, value: unknown): this {
    this.conditions.push({ column: column as keyof UserRecord, value });
    return this;
  }

  returning(selection: readonly string[]): this {
    this.selections = [...selection];
    return this;
  }

  execute(): Promise<unknown[]> {
    this.db.update(this.conditions, this.patch);
    return Promise.resolve([]);
  }

  executeTakeFirst(): Promise<RowProjection | undefined> {
    const updated = this.db.update(this.conditions, this.patch);
    const first = updated[0];
    if (!first) return Promise.resolve(undefined);
    return Promise.resolve(projectRow(first, this.selections));
  }
}

class InMemoryAuthDb {
  private users = new Map<string, UserRecord>();
  private phoneIndex = new Map<string, string>();

  asKysely(): Kysely<Database> {
    return this as unknown as Kysely<Database>;
  }

  selectFrom(_table: 'users'): SelectBuilder {
    return new SelectBuilder(this);
  }

  insertInto(_table: 'users'): InsertBuilder {
    return new InsertBuilder(this);
  }

  updateTable(_table: 'users'): UpdateBuilder {
    return new UpdateBuilder(this);
  }

  find(conditions: readonly Condition[]): UserRecord | undefined {
    return [...this.users.values()].find((user) => this.matches(user, conditions));
  }

  getByPhone(phone: string): UserRecord | undefined {
    const id = this.phoneIndex.get(phone);
    return id ? this.users.get(id) : undefined;
  }

  insert(values: RowProjection): UserRecord {
    const phone = String(values.phone);
    if (this.phoneIndex.has(phone)) {
      throw Object.assign(new Error('duplicate phone'), {
        code: '23505',
        constraint: 'users_phone_key',
      });
    }

    const now = new Date();
    const user: UserRecord = {
      id: randomUUID(),
      phone,
      apple_user_id: null,
      password_hash: String(values.password_hash),
      role: values.role as UserRole,
      refresh_token_jti: null,
      created_at: now,
      updated_at: now,
    };

    this.users.set(user.id, user);
    this.phoneIndex.set(user.phone, user.id);
    return user;
  }

  update(conditions: readonly Condition[], patch: RowProjection): UserRecord[] {
    const updated: UserRecord[] = [];
    for (const user of this.users.values()) {
      if (!this.matches(user, conditions)) continue;
      this.applyPatch(user, patch);
      updated.push(user);
    }
    return updated;
  }

  private matches(user: UserRecord, conditions: readonly Condition[]): boolean {
    return conditions.every((condition) => user[condition.column] === condition.value);
  }

  private applyPatch(user: UserRecord, patch: RowProjection): void {
    if ('refresh_token_jti' in patch) {
      const refreshTokenJti = patch.refresh_token_jti;
      user.refresh_token_jti = typeof refreshTokenJti === 'string' ? refreshTokenJti : null;
    }
    if ('updated_at' in patch) {
      user.updated_at = new Date();
    }
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
    expect(row?.refresh_token_jti).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

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
    const { app, db } = await registerUser();
    const beforeJti = db.getByPhone('+8613800000001')?.refresh_token_jti;

    const response = await request(app).post('/auth/login').send({
      phone: '+8613800000001',
      password: 'hunter2hunter2',
    });

    expect(response.status).toBe(200);
    expect(response.body.user.phone).toBe('+8613800000001');
    expect(typeof response.body.accessToken).toBe('string');
    expect(typeof response.body.refreshToken).toBe('string');
    expect(db.getByPhone('+8613800000001')?.refresh_token_jti).not.toBe(beforeJti);
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
    expect(refreshJti(response.body.refreshToken as string)).not.toBe(oldJti);
    expect(db.getByPhone('+8613800000001')?.refresh_token_jti).not.toBe(oldJti);
  });

  it('detects refresh token reuse and clears the stored jti', async () => {
    const { app, db, response: registerResponse } = await registerUser();
    const oldRefreshToken = registerResponse.body.refreshToken as string;

    const firstRefresh = await request(app).post('/auth/refresh').send({
      refreshToken: oldRefreshToken,
    });
    expect(firstRefresh.status).toBe(200);

    const reuseResponse = await request(app).post('/auth/refresh').send({
      refreshToken: oldRefreshToken,
    });

    expect(reuseResponse.status).toBe(401);
    expect(reuseResponse.body).toEqual({ error: 'AUTH_INVALID_REFRESH' });
    expect(db.getByPhone('+8613800000001')?.refresh_token_jti).toBeNull();
  });

  it('rejects an expired refresh token with AUTH_REFRESH_EXPIRED', async () => {
    const { app, db } = await registerUser();
    const user = db.getByPhone('+8613800000001');
    const expiredToken = jwt.sign(
      { sub: user?.id, role: 'coach', jti: user?.refresh_token_jti, typ: 'refresh' },
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

  it('rotates a legacy refresh token lacking aud/iss and re-issues full-claim tokens', async () => {
    const { app, db } = await registerUser();
    const stored = db.getByPhone('+8613800000001');
    const oldJti = stored?.refresh_token_jti;
    const legacyRefresh = jwt.sign(
      { sub: stored?.id, role: stored?.role, jti: oldJti },
      authConfig.JWT_REFRESH_SECRET,
      { algorithm: 'HS256', expiresIn: '30d' } satisfies SignOptions,
    );

    const response = await request(app).post('/auth/refresh').send({ refreshToken: legacyRefresh });

    expect(response.status).toBe(200);
    expect(typeof response.body.refreshToken).toBe('string');
    // The re-issued token verifies under the strict aud/iss path, so the holder
    // migrates forward on this refresh; the stored jti is rotated.
    expect(refreshJti(response.body.refreshToken as string)).not.toBe(oldJti);
    expect(db.getByPhone('+8613800000001')?.refresh_token_jti).not.toBe(oldJti);
  });

  it('rejects a legacy refresh token when AUTH_ALLOW_LEGACY_TOKENS is false', async () => {
    const { app, db } = makeApp(undefined, { ...authConfig, AUTH_ALLOW_LEGACY_TOKENS: false });
    const registerResponse = await request(app)
      .post('/auth/register')
      .send({ phone: '+8613800000001', password: 'hunter2hunter2', role: 'coach' });
    expect(registerResponse.status).toBe(201);
    const stored = db.getByPhone('+8613800000001');
    const legacyRefresh = jwt.sign(
      { sub: stored?.id, role: stored?.role, jti: stored?.refresh_token_jti },
      authConfig.JWT_REFRESH_SECRET,
      { algorithm: 'HS256', expiresIn: '30d' } satisfies SignOptions,
    );

    const response = await request(app).post('/auth/refresh').send({ refreshToken: legacyRefresh });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'AUTH_INVALID_REFRESH' });
  });
});
