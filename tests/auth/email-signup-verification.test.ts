import bcrypt from 'bcrypt';
import { createHash, randomUUID } from 'node:crypto';
import type * as crypto from 'node:crypto';
import fs from 'node:fs';

import type { Kysely } from 'kysely';
import { DataType, newDb } from 'pg-mem';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app';
import type { Config } from '../../src/config';
import { createDb } from '../../src/db/kysely';
import type { Database } from '../../src/db/types';
import { request } from '../helpers/inMemoryRequest';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof crypto>();
  let nextCode = 100000;
  return { ...actual, randomInt: () => nextCode++ };
});

const config: Config = {
  NODE_ENV: 'test',
  PORT: 3000,
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  JWT_ACCESS_SECRET: 'email-recovery-access-secret-minimum-32',
  JWT_REFRESH_SECRET: 'email-recovery-refresh-secret-minimum-32',
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
  EMAIL_SIGNUP_VERIFICATION: 'required',
  SELF_SIGNUP_ROLES: 'coached_student',
  RESEND_API_KEY: 'resend-test-key',
  EMAIL_FROM: 'MeetPR <no-reply@example.com>',
};

function makeContext(configOverride: Partial<Config> = {}, omitGate = false) {
  const mem = newDb();
  // pg-mem has no advisory locks; these tests verify serial HTTP behavior only.
  mem.public.registerFunction({
    name: 'hashtext',
    args: [DataType.text],
    returns: DataType.integer,
    implementation: () => 1,
  });
  mem.public.registerFunction({
    name: 'pg_advisory_xact_lock',
    args: [DataType.integer],
    returns: DataType.integer,
    implementation: () => 1,
  });
  mem.public.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.uuid,
    impure: true,
    implementation: randomUUID,
  });
  mem.public.none(fs.readFileSync('db/migrations/0001-init-users.sql', 'utf8'));
  mem.public.none(fs.readFileSync('db/migrations/0039-multi-device-sessions.sql', 'utf8'));
  mem.public.none(fs.readFileSync('db/migrations/0064-global-identity.sql', 'utf8'));
  mem.public.none(fs.readFileSync('db/migrations/0065-email-channel.sql', 'utf8'));
  mem.public.none(fs.readFileSync('db/migrations/0066-add-user-timezone.sql', 'utf8'));
  mem.public.none(fs.readFileSync('db/migrations/0072-email-signup-codes.sql', 'utf8'));
  const { Pool } = mem.adapters.createPg();
  const db: Kysely<Database> = createDb(new Pool());
  const appConfig = { ...config, ...configOverride };
  if (omitGate) delete appConfig.EMAIL_SIGNUP_VERIFICATION;
  const app = createApp({
    config: appConfig,
    db,
    logger: pino({ level: 'silent' }),
  });
  return { app, db };
}

function stubResend(status = 202) {
  const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status })));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function codeFromResend(fetchMock: ReturnType<typeof stubResend>, callIndex = 0): string {
  const init = fetchMock.mock.calls[callIndex]?.[1];
  if (typeof init?.body !== 'string') throw new Error('expected Resend JSON body');
  const payload = JSON.parse(init.body) as { text?: unknown };
  const match = typeof payload.text === 'string' ? /\b(\d{6})\b/.exec(payload.text) : null;
  if (!match?.[1]) throw new Error('expected six-digit code in email');
  return match[1];
}

const email = 'student@example.com';
const password = 'original-password';
function register(app: ReturnType<typeof createApp>, code?: unknown, extra = {}) {
  return request(app)
    .post('/auth/email/register')
    .send({
      email,
      password,
      role: 'coached_student',
      ...(code === undefined ? {} : { code }),
      ...extra,
    });
}
function issue(app: ReturnType<typeof createApp>, address = email) {
  return request(app).post('/auth/email/register/code').send({ email: address });
}
afterEach(() => vi.unstubAllGlobals());

describe('email signup verification', () => {
  it('keeps legacy registration unverified and ignores code when off; code endpoint is 404', async () => {
    const fetchMock = stubResend();
    const { app, db } = makeContext({ EMAIL_SIGNUP_VERIFICATION: 'off' });
    expect((await register(app, 'ignored')).status).toBe(201);
    expect(
      (await db.selectFrom('users').select('email_verified_at').executeTakeFirstOrThrow())
        .email_verified_at,
    ).toBeNull();
    const missingPath = '/auth/no-such-signup-route';
    const missing = await request(app).post(missingPath).send({ email });
    expect(missing.status).toBe(404);
    expect(missing.body.path).toBe(missingPath);
    for (let i = 0; i < 7; i++) {
      const response = await issue(app);
      expect(response.status).toBe(missing.status);
      expect(response.body.path).toBe('/auth/email/register/code');
      // notFound includes the requested path; compare the complete envelope
      // after normalizing that request-specific field.
      expect({ ...response.body, path: missingPath }).toEqual(missing.body);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a missing signup code before hashing the password', async () => {
    stubResend();
    const { app, db } = makeContext();
    const hashSpy = vi.spyOn(bcrypt, 'hash');
    try {
      const response = await register(app);
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'AUTH_INVALID_SIGNUP_CODE' });
      expect(await db.selectFrom('users').select('id').execute()).toHaveLength(0);
      expect(hashSpy).not.toHaveBeenCalled();
    } finally {
      hashSpy.mockRestore();
    }
  });

  it.each(['missing', 'absent', 'wrong', 'expired', 'used'] as const)(
    'rejects %s codes without creating a user',
    async (state) => {
      const fetchMock = stubResend();
      const { app, db } = makeContext();
      let code = '123456';
      if (state !== 'absent') {
        expect((await issue(app)).status).toBe(204);
        code = codeFromResend(fetchMock);
      }
      if (state === 'expired')
        await db
          .updateTable('email_signup_codes')
          .set({ expires_at: new Date(0) })
          .execute();
      if (state === 'used')
        await db.updateTable('email_signup_codes').set({ used_at: new Date() }).execute();
      if (state === 'wrong') code = code === '000000' ? '000001' : '000000';
      const result = await register(app, state === 'missing' ? undefined : code);
      expect(result.status).toBe(401);
      expect(result.body).toEqual({ error: 'AUTH_INVALID_SIGNUP_CODE' });
      expect(await db.selectFrom('users').select('id').execute()).toHaveLength(0);
    },
  );

  it('issues a hashed ten-minute code, verifies registration and permits immediate login', async () => {
    const fetchMock = stubResend();
    const { app, db } = makeContext();
    const before = Date.now();
    expect((await issue(app, ' STUDENT@EXAMPLE.COM ')).status).toBe(204);
    const code = codeFromResend(fetchMock);
    const stored = await db.selectFrom('email_signup_codes').selectAll().executeTakeFirstOrThrow();
    expect(stored.email).toBe(email);
    expect(stored.code_hash).toBe(createHash('sha256').update(code).digest('hex'));
    expect(stored.expires_at.getTime()).toBeGreaterThanOrEqual(before + 600_000);
    expect(stored.expires_at.getTime()).toBeLessThanOrEqual(Date.now() + 600_000);
    const result = await register(app, code);
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      user: { email, role: 'coached_student' },
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
    });
    expect(
      (await db.selectFrom('users').select('email_verified_at').executeTakeFirstOrThrow())
        .email_verified_at,
    ).toBeInstanceOf(Date);
    expect(
      await db.selectFrom('email_signup_codes').selectAll().executeTakeFirstOrThrow(),
    ).toMatchObject({ attempts: 1, used_at: expect.any(Date) });
    expect((await request(app).post('/auth/email/login').send({ email, password })).status).toBe(
      200,
    );
    expect((await register(app, code)).body).toEqual({ error: 'AUTH_INVALID_SIGNUP_CODE' });
  });

  it('invalidates the previous code on reissue and deletes expired rows', async () => {
    const fetchMock = stubResend();
    const { app, db } = makeContext();
    await db
      .insertInto('email_signup_codes')
      .values({ email, code_hash: 'expired', expires_at: new Date(0) })
      .execute();
    await issue(app);
    const old = codeFromResend(fetchMock);
    await issue(app);
    const current = codeFromResend(fetchMock, 1);
    expect(current).not.toBe(old);
    const rows = await db.selectFrom('email_signup_codes').selectAll().execute();
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.used_at === null)).toHaveLength(1);
    expect((await register(app, old)).status).toBe(401);
    expect((await register(app, current)).status).toBe(201);
  });

  it('persists wrong attempts and invalidates the code after five failures', async () => {
    const fetchMock = stubResend();
    const { app, db } = makeContext();
    await issue(app);
    const code = codeFromResend(fetchMock);
    for (let attempts = 1; attempts <= 5; attempts++) {
      expect((await register(app, code === '000000' ? '000001' : '000000')).body).toEqual({
        error: 'AUTH_INVALID_SIGNUP_CODE',
      });
      expect(
        (await db.selectFrom('email_signup_codes').select('attempts').executeTakeFirstOrThrow())
          .attempts,
      ).toBe(attempts);
    }
    expect((await register(app, code)).status).toBe(401);
    expect(
      (await db.selectFrom('email_signup_codes').select('used_at').executeTakeFirstOrThrow())
        .used_at,
    ).toBeInstanceOf(Date);
    expect(await db.selectFrom('users').select('id').execute()).toHaveLength(0);
  });

  it('sends an already-registered notice without creating a code', async () => {
    const fetchMock = stubResend();
    const { app, db } = makeContext();
    await issue(app);
    await register(app, codeFromResend(fetchMock));
    await db.deleteFrom('email_signup_codes').execute();
    expect((await issue(app, ' STUDENT@EXAMPLE.COM ')).status).toBe(204);
    expect(await db.selectFrom('email_signup_codes').select('id').execute()).toHaveLength(0);
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toMatchObject({
      subject: 'You already have a MeetPR account',
    });
  });

  it('silently limits normalized email to five sends per hour', async () => {
    const fetchMock = stubResend();
    const { app } = makeContext();
    for (let i = 0; i < 6; i++)
      expect((await issue(app, i % 2 ? ' STUDENT@EXAMPLE.COM ' : email)).status).toBe(204);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('silently limits an IP to thirty sends per hour', async () => {
    const fetchMock = stubResend();
    const { app } = makeContext();
    for (let i = 0; i < 31; i++)
      expect((await issue(app, `student${String(i)}@example.com`)).status).toBe(204);
    expect(fetchMock).toHaveBeenCalledTimes(30);
  });

  it('checks body and signup policy before verification', async () => {
    const fetchMock = stubResend();
    const { app } = makeContext({ SELF_SIGNUP_ROLES: '' });
    expect((await register(app, 'bad')).status).toBe(400);
    expect((await register(app)).body).toEqual({ error: 'AUTH_REGISTRATION_DISABLED' });
    for (let i = 0; i < 7; i++)
      expect((await issue(app)).body).toEqual({ error: 'AUTH_REGISTRATION_DISABLED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 204 when mail fails or remains pending', async () => {
    const fetchMock = stubResend(503);
    const { app } = makeContext();
    expect((await issue(app)).status).toBe(204);
    let resolveMail: ((response: Response) => void) | undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveMail = resolve;
        }),
    );
    expect((await issue(app)).status).toBe(204);
    resolveMail?.(new Response(null, { status: 202 }));
  });

  it('passes the configured Chinese locale to signup, notice and recovery emails', async () => {
    const fetchMock = stubResend();
    const { app } = makeContext({ MAIL_LOCALE: 'zh' });
    await issue(app);
    await register(app, codeFromResend(fetchMock));
    await issue(app);
    await request(app).post('/auth/email/forgot').send({ email });
    expect(
      fetchMock.mock.calls.map(
        (call) => (JSON.parse(call[1]?.body as string) as { subject: string }).subject,
      ),
    ).toEqual(['MeetPR 注册验证码', '你已经有 MeetPR 账号了', 'MeetPR 重置密码验证码']);
  });
});

describe('signup compatibility and conflicts', () => {
  it('defaults direct app configuration to legacy registration', async () => {
    stubResend();
    const { app, db } = makeContext({}, true);
    expect((await register(app)).status).toBe(201);
    expect(
      (await db.selectFrom('users').select('email_verified_at').executeTakeFirstOrThrow())
        .email_verified_at,
    ).toBeNull();
  });

  it('returns AUTH_EMAIL_TAKEN if the email is claimed after code issuance', async () => {
    const fetchMock = stubResend();
    const { app, db } = makeContext();
    await issue(app);
    const code = codeFromResend(fetchMock);
    const user = await db
      .insertInto('users')
      .values({ email, password_hash: 'existing-hash', role: 'coached_student' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('user_identities')
      .values({
        user_id: user.id,
        provider: 'email',
        provider_uid: email,
        email_at_provider: email,
      })
      .execute();
    const result = await register(app, code);
    expect(result.status).toBe(409);
    expect(result.body).toEqual({ error: 'AUTH_EMAIL_TAKEN' });
    expect(await db.selectFrom('users').select('id').execute()).toHaveLength(1);
  });

  it('allows the correct code on the fifth attempt', async () => {
    const fetchMock = stubResend();
    const { app } = makeContext();
    await issue(app);
    const code = codeFromResend(fetchMock);
    for (let i = 0; i < 4; i++) expect((await register(app, '000000')).status).toBe(401);
    expect((await register(app, code)).status).toBe(201);
  });
});
