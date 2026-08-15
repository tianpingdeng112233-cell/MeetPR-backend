import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import fs from 'node:fs';

import jwt, { type SignOptions } from 'jsonwebtoken';
import type { Kysely } from 'kysely';
import { DataType, newDb } from 'pg-mem';
import pino from 'pino';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app';
import type { Config } from '../../src/config';
import { createDb } from '../../src/db/kysely';
import type { Database } from '../../src/db/types';

const config: Config = {
  NODE_ENV: 'test',
  PORT: 3000,
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  JWT_ACCESS_SECRET: 'global-access-secret-for-auth-tests-min-32',
  JWT_REFRESH_SECRET: 'global-refresh-secret-for-auth-tests-min-32',
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
  APPLE_CLIENT_ID: 'com.meetpr.global',
  GOOGLE_CLIENT_ID: 'google-client-id.apps.googleusercontent.com',
};

const signingKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const forgedKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = 'global-auth-test-key';
const publicJwk = {
  ...signingKeys.publicKey.export({ format: 'jwk' }),
  kid,
  alg: 'RS256',
  use: 'sig',
};

function token(input: {
  provider: 'apple' | 'google';
  subject?: string;
  audience?: string;
  expiresIn?: SignOptions['expiresIn'];
  missingExp?: boolean;
  nonce?: string;
  forged?: boolean;
}) {
  const apple = input.provider === 'apple';
  return jwt.sign(
    {
      sub: input.subject ?? `${input.provider}-${randomUUID()}`,
      email: 'identity@example.com',
      ...(input.nonce === undefined ? {} : { nonce: input.nonce }),
    },
    input.forged ? forgedKeys.privateKey : signingKeys.privateKey,
    {
      algorithm: 'RS256',
      keyid: kid,
      issuer: apple ? 'https://appleid.apple.com' : 'https://accounts.google.com',
      audience: input.audience ?? (apple ? config.APPLE_CLIENT_ID : config.GOOGLE_CLIENT_ID),
      ...(input.missingExp ? {} : { expiresIn: input.expiresIn ?? '5m' }),
    },
  );
}

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
  mem.public.none(fs.readFileSync('db/migrations/0066-add-user-timezone.sql', 'utf8'));
  const { Pool } = mem.adapters.createPg();
  const db: Kysely<Database> = createDb(new Pool());
  const app = createApp({
    config: { ...config, ...configOverride },
    db,
    logger: pino({ level: 'silent' }),
  });
  return { app, db, mem };
}

function stubJwks(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ keys: [publicJwk] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ),
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function issueChallenge(app: ReturnType<typeof createApp>): Promise<string> {
  const response = await request(app).post('/auth/challenge').send({});
  expect(response.status).toBe(200);
  expect(new Date(response.body.expiresAt as string).getTime()).toBeGreaterThan(Date.now());
  return response.body.nonce as string;
}

function sendProviderToken(
  app: ReturnType<typeof createApp>,
  provider: 'apple' | 'google',
  identityToken: string,
  role = 'coached_student',
  nonce?: string,
  timezone?: string,
) {
  return provider === 'apple'
    ? request(app)
        .post('/auth/apple')
        .send({
          identityToken,
          ...(nonce ? { nonce } : {}),
          role,
          ...(timezone ? { timezone } : {}),
        })
    : request(app)
        .post('/auth/google')
        .send({
          idToken: identityToken,
          ...(nonce ? { nonce } : {}),
          role,
          ...(timezone ? { timezone } : {}),
        });
}

async function providerRequest(
  app: ReturnType<typeof createApp>,
  provider: 'apple' | 'google',
  tokenInput: Omit<Parameters<typeof token>[0], 'provider' | 'nonce'> = {},
  role = 'coached_student',
  timezone?: string,
) {
  const nonce = provider === 'apple' ? await issueChallenge(app) : undefined;
  const identityToken = token({
    provider,
    ...tokenInput,
    ...(nonce === undefined ? {} : { nonce: sha256(nonce) }),
  });
  return sendProviderToken(app, provider, identityToken, role, nonce, timezone);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(['apple', 'google'] as const)('POST /auth/%s', (provider) => {
  it('creates once, signs standard tokens, and logs the existing identity back in', async () => {
    stubJwks();
    const { app, mem } = makeContext();
    const subject = `${provider}-stable-subject`;

    const first = await providerRequest(app, provider, { subject });
    expect(first.status).toBe(200);
    expect(first.body.user).toMatchObject({
      phone: null,
      email: 'identity@example.com',
      role: 'coached_student',
    });
    expect(jwt.verify(first.body.accessToken as string, config.JWT_ACCESS_SECRET)).toMatchObject({
      sub: first.body.user.id,
      role: 'coached_student',
      typ: 'access',
    });

    const me = await request(app)
      .get('/me')
      .set('Authorization', `Bearer ${String(first.body.accessToken)}`);
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(first.body.user.id);

    const second = await providerRequest(app, provider, { subject });
    expect(second.status).toBe(200);
    expect(second.body.user.id).toBe(first.body.user.id);
    expect(mem.public.one(`SELECT count(*)::int AS count FROM users;`)).toEqual({ count: 1 });
    expect(mem.public.one(`SELECT count(*)::int AS count FROM user_identities;`)).toEqual({
      count: 1,
    });
  });

  it('stores the optional timezone only when the identity is first created', async () => {
    stubJwks();
    const { app, db } = makeContext();
    const subject = `${provider}-timezone-subject`;

    const first = await providerRequest(
      app,
      provider,
      { subject },
      'coached_student',
      'Europe/London',
    );
    const second = await providerRequest(
      app,
      provider,
      { subject },
      'coached_student',
      'America/New_York',
    );
    const row = await db.selectFrom('users').select('timezone').executeTakeFirstOrThrow();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(row.timezone).toBe('Europe/London');
    expect(first.body.user).not.toHaveProperty('timezone');
  });

  it('rejects a forged token', async () => {
    stubJwks();
    const { app } = makeContext();
    const response = await providerRequest(app, provider, { forged: true });
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'AUTH_INVALID_IDENTITY_TOKEN' });
  });

  it('rejects an audience mismatch', async () => {
    stubJwks();
    const { app } = makeContext();
    const response = await providerRequest(app, provider, { audience: 'wrong-client-id' });
    expect(response.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    stubJwks();
    const { app } = makeContext();
    const response = await providerRequest(app, provider, { expiresIn: -1 });
    expect(response.status).toBe(401);
  });

  it('rejects a correctly signed token without exp', async () => {
    stubJwks();
    const { app } = makeContext();
    const response = await providerRequest(app, provider, { missingExp: true });
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'AUTH_INVALID_IDENTITY_TOKEN' });
  });

  it('returns provider unavailable when JWKS is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('<html>bad gateway</html>', { status: 200 }))),
    );
    const { app } = makeContext();
    const response = await providerRequest(app, provider);
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'AUTH_PROVIDER_UNAVAILABLE', provider });
  });

  it('returns provider unavailable when the matching JWK cannot create a public key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ keys: [{ kid, kty: 'RSA', alg: 'RS256', use: 'sig' }] }), {
            status: 200,
          }),
        ),
      ),
    );
    const { app } = makeContext();
    const response = await providerRequest(app, provider);
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'AUTH_PROVIDER_UNAVAILABLE', provider });
  });

  it('rejects coach self-signup after successful verification', async () => {
    stubJwks();
    const { app } = makeContext();
    const response = await providerRequest(app, provider, {}, 'coach');
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'AUTH_REGISTRATION_NOT_ALLOWED' });
  });
});

describe('POST /auth/apple nonce validation', () => {
  it('rejects replay of the same challenge', async () => {
    stubJwks();
    const { app } = makeContext();
    const nonce = await issueChallenge(app);
    const identityToken = token({ provider: 'apple', nonce: sha256(nonce) });

    const first = await sendProviderToken(app, 'apple', identityToken, 'coached_student', nonce);
    const replay = await sendProviderToken(app, 'apple', identityToken, 'coached_student', nonce);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(401);
    expect(replay.body).toEqual({ error: 'AUTH_INVALID_IDENTITY_TOKEN' });
  });

  it('rejects an expired challenge', async () => {
    stubJwks();
    const { app, db } = makeContext();
    const nonce = await issueChallenge(app);
    await db
      .updateTable('auth_challenges')
      .set({ issued_at: new Date(Date.now() - 10 * 60 * 1000 - 1) })
      .execute();

    const response = await sendProviderToken(
      app,
      'apple',
      token({ provider: 'apple', nonce: sha256(nonce) }),
      'coached_student',
      nonce,
    );

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'AUTH_INVALID_IDENTITY_TOKEN' });
  });

  it('rejects a SHA-256 nonce mismatch and consumes the challenge', async () => {
    stubJwks();
    const { app } = makeContext();
    const nonce = await issueChallenge(app);
    const identityToken = token({ provider: 'apple', nonce: sha256('different-raw-nonce') });

    const response = await sendProviderToken(app, 'apple', identityToken, 'coached_student', nonce);
    const retry = await sendProviderToken(app, 'apple', identityToken, 'coached_student', nonce);

    expect(response.status).toBe(401);
    expect(retry.status).toBe(401);
  });

  it('rejects Apple login without a nonce', async () => {
    stubJwks();
    const { app } = makeContext();
    const response = await sendProviderToken(app, 'apple', token({ provider: 'apple' }));

    expect(response.status).toBe(400);
  });
});

describe('POST /auth/challenge', () => {
  it('returns a ten-minute raw nonce while persisting only its hash', async () => {
    const { app, mem } = makeContext();
    const before = Date.now();
    const response = await request(app).post('/auth/challenge').send({});
    const after = Date.now();

    expect(response.status).toBe(200);
    expect(typeof response.body.nonce).toBe('string');
    expect(new Date(response.body.expiresAt as string).getTime()).toBeGreaterThanOrEqual(
      before + 10 * 60 * 1000,
    );
    expect(new Date(response.body.expiresAt as string).getTime()).toBeLessThanOrEqual(
      after + 10 * 60 * 1000,
    );
    expect(mem.public.one(`SELECT nonce_hash FROM auth_challenges;`)).toEqual({
      nonce_hash: sha256(response.body.nonce as string),
    });
  });
});

describe('POST /auth/google optional nonce validation', () => {
  it('validates and consumes a nonce when the Google client supplies one', async () => {
    stubJwks();
    const { app } = makeContext();
    const nonce = await issueChallenge(app);
    const identityToken = token({ provider: 'google', nonce: sha256(nonce) });

    const first = await sendProviderToken(app, 'google', identityToken, 'coached_student', nonce);
    const replay = await sendProviderToken(app, 'google', identityToken, 'coached_student', nonce);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(401);
  });
});

describe('email identity', () => {
  it('registers unverified, logs in case-insensitively, and returns standard tokens', async () => {
    const { app, mem } = makeContext();
    const registration = await request(app).post('/auth/email/register').send({
      email: 'Student@Example.com',
      password: 'hunter2hunter2',
      role: 'coached_student',
      timezone: 'Europe/London',
    });
    expect(registration.status).toBe(201);
    expect(registration.body.user).toMatchObject({
      phone: null,
      email: 'student@example.com',
      role: 'coached_student',
    });
    expect(mem.public.one(`SELECT email, email_verified_at, timezone FROM users;`)).toEqual({
      email: 'student@example.com',
      email_verified_at: null,
      timezone: 'Europe/London',
    });

    const login = await request(app).post('/auth/email/login').send({
      email: 'STUDENT@example.com',
      password: 'hunter2hunter2',
    });
    expect(login.status).toBe(200);
    expect(login.body.user.id).toBe(registration.body.user.id);
    expect(typeof login.body.accessToken).toBe('string');
    expect(typeof login.body.refreshToken).toBe('string');
  });

  it('rejects bad credentials without revealing email existence', async () => {
    const { app } = makeContext();
    const missing = await request(app).post('/auth/email/login').send({
      email: 'missing@example.com',
      password: 'hunter2hunter2',
    });
    expect(missing.status).toBe(401);
    expect(missing.body).toEqual({ error: 'AUTH_INVALID_CREDENTIALS' });
  });

  it('rejects coach self-registration', async () => {
    const { app } = makeContext();
    const response = await request(app).post('/auth/email/register').send({
      email: 'coach@example.com',
      password: 'hunter2hunter2',
      role: 'coach',
    });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'AUTH_REGISTRATION_NOT_ALLOWED' });
  });
});

describe('global auth safe defaults', () => {
  it.each(['/auth/apple', '/auth/google', '/auth/email/register'])(
    'rejects an invalid timezone on %s',
    async (path) => {
      const { app } = makeContext();
      const response = await request(app).post(path).send({ timezone: 'Mars/Olympus_Mons' });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'INVALID_TIMEZONE' });
    },
  );

  it('returns explicit provider configuration errors without blocking app startup', async () => {
    const { app } = makeContext({ APPLE_CLIENT_ID: undefined, GOOGLE_CLIENT_ID: undefined });
    const apple = await request(app).post('/auth/apple').send({
      identityToken: 'not-read-before-config-gate',
      nonce: 'nonce',
      role: 'coached_student',
    });
    const google = await request(app).post('/auth/google').send({
      idToken: 'not-read-before-config-gate',
      role: 'coached_student',
    });
    expect(apple.status).toBe(503);
    expect(google.status).toBe(503);
  });

  it('fails self-registration shut when SELF_SIGNUP_ROLES is omitted', async () => {
    const { app } = makeContext({ SELF_SIGNUP_ROLES: undefined });
    const response = await request(app).post('/auth/email/register').send({
      email: 'student@example.com',
      password: 'hunter2hunter2',
      role: 'coached_student',
    });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'AUTH_REGISTRATION_DISABLED' });
  });
});
