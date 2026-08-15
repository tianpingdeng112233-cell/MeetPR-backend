import { createHash, randomUUID } from 'node:crypto';
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
  SELF_SIGNUP_ROLES: 'coached_student',
  RESEND_API_KEY: 'resend-test-key',
  EMAIL_FROM: 'MeetPR <no-reply@example.com>',
};

function makeContext(configOverride: Partial<Config> = {}) {
  const mem = newDb();
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
  const { Pool } = mem.adapters.createPg();
  const db: Kysely<Database> = createDb(new Pool());
  const app = createApp({
    config: { ...config, ...configOverride },
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

async function register(app: ReturnType<typeof createApp>, email = 'student@example.com') {
  const response = await request(app).post('/auth/email/register').send({
    email,
    password: 'original-password',
    role: 'coached_student',
  });
  expect(response.status).toBe(201);
  return response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('email password recovery', () => {
  it('resets the password, consumes the code, and revokes every old session', async () => {
    const fetchMock = stubResend();
    const { app, db } = makeContext();
    const registration = await register(app);
    const secondLogin = await request(app).post('/auth/email/login').send({
      email: 'STUDENT@example.com',
      password: 'original-password',
    });
    expect(secondLogin.status).toBe(200);

    const forgot = await request(app)
      .post('/auth/email/forgot')
      .send({ email: 'Student@Example.com' });
    expect(forgot.status).toBe(204);
    const code = codeFromResend(fetchMock);
    const stored = await db
      .selectFrom('password_reset_codes')
      .select(['code_hash', 'attempts', 'used_at'])
      .executeTakeFirstOrThrow();
    expect(stored.code_hash).toBe(createHash('sha256').update(code).digest('hex'));
    expect(stored.code_hash).not.toBe(code);

    const reset = await request(app).post('/auth/email/reset').send({
      email: 'student@example.com',
      code,
      newPassword: 'brand-new-password',
    });
    expect(reset.status).toBe(204);

    const used = await db
      .selectFrom('password_reset_codes')
      .select(['attempts', 'used_at'])
      .executeTakeFirstOrThrow();
    expect(used.attempts).toBe(1);
    expect(used.used_at).toBeInstanceOf(Date);
    const sessions = await db
      .selectFrom('sessions')
      .select('revoked_at')
      .where('user_id', '=', registration.body.user.id as string)
      .execute();
    expect(sessions).toHaveLength(2);
    expect(sessions.every((session) => session.revoked_at instanceof Date)).toBe(true);

    for (const refreshToken of [registration.body.refreshToken, secondLogin.body.refreshToken]) {
      const refresh = await request(app).post('/auth/refresh').send({ refreshToken });
      expect(refresh.status).toBe(401);
    }
    const oldLogin = await request(app).post('/auth/email/login').send({
      email: 'student@example.com',
      password: 'original-password',
    });
    const newLogin = await request(app).post('/auth/email/login').send({
      email: 'student@example.com',
      password: 'brand-new-password',
    });
    expect(oldLogin.status).toBe(401);
    expect(newLogin.status).toBe(200);

    const reuse = await request(app).post('/auth/email/reset').send({
      email: 'student@example.com',
      code,
      newPassword: 'another-new-password',
    });
    expect(reuse.status).toBe(401);
    expect(reuse.body).toEqual({ error: 'AUTH_INVALID_RESET_CODE' });
  });

  it('persists every attempt first and invalidates a code after five wrong tries', async () => {
    const fetchMock = stubResend();
    const { app, db } = makeContext();
    await register(app);
    await request(app).post('/auth/email/forgot').send({ email: 'student@example.com' });
    const code = codeFromResend(fetchMock);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await request(app)
        .post('/auth/email/reset')
        .send({
          email: 'student@example.com',
          code: code === '999999' ? '000000' : '999999',
          newPassword: 'brand-new-password',
        });
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'AUTH_INVALID_RESET_CODE' });
      const row = await db
        .selectFrom('password_reset_codes')
        .select(['attempts', 'used_at'])
        .executeTakeFirstOrThrow();
      expect(row.attempts).toBe(attempt);
      expect(row.used_at === null).toBe(attempt < 5);
    }

    const correctAfterFive = await request(app).post('/auth/email/reset').send({
      email: 'student@example.com',
      code,
      newPassword: 'brand-new-password',
    });
    expect(correctAfterFive.status).toBe(401);
    expect(correctAfterFive.body).toEqual({ error: 'AUTH_INVALID_RESET_CODE' });
  });

  it('rejects expired codes with the same reset error', async () => {
    const fetchMock = stubResend();
    const { app, db } = makeContext();
    await register(app);
    await request(app).post('/auth/email/forgot').send({ email: 'student@example.com' });
    const code = codeFromResend(fetchMock);
    await db
      .updateTable('password_reset_codes')
      .set({ expires_at: new Date(Date.now() - 1) })
      .execute();

    const response = await request(app).post('/auth/email/reset').send({
      email: 'student@example.com',
      code,
      newPassword: 'brand-new-password',
    });
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'AUTH_INVALID_RESET_CODE' });
  });

  it('makes non-email identities and missing accounts indistinguishable on forgot', async () => {
    const fetchMock = stubResend();
    const { app, db } = makeContext();
    const appleUser = await db
      .insertInto('users')
      .values({ password_hash: 'not-a-local-credential', role: 'coached_student' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('user_identities')
      .values({
        user_id: appleUser.id,
        provider: 'apple',
        provider_uid: 'apple-only-subject',
        email_at_provider: 'apple-only@example.com',
      })
      .execute();

    const appleOnly = await request(app)
      .post('/auth/email/forgot')
      .send({ email: 'apple-only@example.com' });
    const missing = await request(app)
      .post('/auth/email/forgot')
      .send({ email: 'missing@example.com' });
    expect({ status: appleOnly.status, text: appleOnly.text }).toEqual({ status: 204, text: '' });
    expect({ status: missing.status, text: missing.text }).toEqual({ status: 204, text: '' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('responds 204 without waiting for mail delivery', async () => {
    let resolveDelivery: ((value: Response) => void) | undefined;
    const hangingFetch = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          resolveDelivery = resolve;
        }),
    );
    vi.stubGlobal('fetch', hangingFetch);
    const { app } = makeContext();
    await register(app);

    const response = await request(app)
      .post('/auth/email/forgot')
      .send({ email: 'student@example.com' });

    expect(response.status).toBe(204);
    expect(hangingFetch).toHaveBeenCalledOnce();
    resolveDelivery?.(new Response(null, { status: 200 }));
  });

  it('keeps forgot at 204 when Resend fails or is not configured', async () => {
    const failingFetch = stubResend(503);
    const failing = makeContext();
    await register(failing.app);
    const providerFailure = await request(failing.app)
      .post('/auth/email/forgot')
      .send({ email: 'student@example.com' });
    expect(providerFailure.status).toBe(204);
    expect(failingFetch).toHaveBeenCalledOnce();

    vi.unstubAllGlobals();
    const disabledFetch = stubResend();
    const disabled = makeContext({ RESEND_API_KEY: undefined, EMAIL_FROM: undefined });
    await register(disabled.app, 'disabled@example.com');
    const notConfigured = await request(disabled.app)
      .post('/auth/email/forgot')
      .send({ email: 'disabled@example.com' });
    expect(notConfigured.status).toBe(204);
    expect(disabledFetch).not.toHaveBeenCalled();
  });

  it('silently enforces forgot per-email and per-IP limits', async () => {
    const perEmailFetch = stubResend();
    const perEmail = makeContext();
    await register(perEmail.app);
    for (let requestIndex = 0; requestIndex < 4; requestIndex += 1) {
      const response = await request(perEmail.app)
        .post('/auth/email/forgot')
        .send({ email: 'student@example.com' });
      expect(response.status).toBe(204);
    }
    expect(perEmailFetch).toHaveBeenCalledTimes(3);
    const issuedCodes = await perEmail.db
      .selectFrom('password_reset_codes')
      .select('used_at')
      .execute();
    expect(issuedCodes).toHaveLength(3);
    expect(issuedCodes.filter((code) => code.used_at === null)).toHaveLength(1);

    vi.unstubAllGlobals();
    const perIpFetch = stubResend();
    const perIp = makeContext();
    for (let index = 0; index < 11; index += 1) {
      const email = `student-${String(index)}@example.com`;
      const user = await perIp.db
        .insertInto('users')
        .values({ email, password_hash: 'hash', role: 'coached_student' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await perIp.db
        .insertInto('user_identities')
        .values({
          user_id: user.id,
          provider: 'email',
          provider_uid: email,
          email_at_provider: email,
        })
        .execute();
      const response = await request(perIp.app).post('/auth/email/forgot').send({ email });
      expect(response.status).toBe(204);
    }
    expect(perIpFetch).toHaveBeenCalledTimes(10);
  });

  it('enforces the reset per-email limit after ten attempts', async () => {
    const { app } = makeContext();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await request(app).post('/auth/email/reset').send({
        email: 'missing@example.com',
        code: '123456',
        newPassword: 'brand-new-password',
      });
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'AUTH_INVALID_RESET_CODE' });
    }
    const limited = await request(app).post('/auth/email/reset').send({
      email: 'missing@example.com',
      code: '123456',
      newPassword: 'brand-new-password',
    });
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'rate_limited' });
  });
});
