import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import fs from 'node:fs';

import jwt, { type SignOptions } from 'jsonwebtoken';
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
const siwaPrivateKey = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  .privateKey.export({ format: 'pem', type: 'pkcs8' })
  .toString();
const siwaConfig: Partial<Config> = {
  SIWA_KEY_ID: 'SIWAKEY',
  SIWA_TEAM_ID: 'TEAMID',
  SIWA_PRIVATE_KEY: siwaPrivateKey,
};
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
  mem.public.none(fs.readFileSync('db/migrations/0065-email-channel.sql', 'utf8'));
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
  authorizationCode?: string,
) {
  return provider === 'apple'
    ? request(app)
        .post('/auth/apple')
        .send({
          identityToken,
          ...(nonce ? { nonce } : {}),
          role,
          ...(authorizationCode ? { authorizationCode } : {}),
        })
    : request(app)
        .post('/auth/google')
        .send({ idToken: identityToken, ...(nonce ? { nonce } : {}), role });
}

async function providerRequest(
  app: ReturnType<typeof createApp>,
  provider: 'apple' | 'google',
  tokenInput: Omit<Parameters<typeof token>[0], 'provider' | 'nonce'> = {},
  role = 'coached_student',
  authorizationCode?: string,
) {
  const nonce = provider === 'apple' ? await issueChallenge(app) : undefined;
  const identityToken = token({
    provider,
    ...tokenInput,
    ...(nonce === undefined ? {} : { nonce: sha256(nonce) }),
  });
  return sendProviderToken(app, provider, identityToken, role, nonce, authorizationCode);
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function stubAppleEndpoints(options: { tokenStatus?: number; revokeStatus?: number } = {}) {
  const fetchMock = vi.fn<typeof fetch>((input) => {
    const url = requestUrl(input);
    if (url === 'https://appleid.apple.com/auth/keys') {
      return Promise.resolve(
        new Response(JSON.stringify({ keys: [publicJwk] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    if (url === 'https://appleid.apple.com/auth/token') {
      return Promise.resolve(
        new Response(JSON.stringify({ refresh_token: 'stored-apple-refresh-token' }), {
          status: options.tokenStatus ?? 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    if (url === 'https://appleid.apple.com/auth/revoke') {
      return Promise.resolve(new Response(null, { status: options.revokeStatus ?? 200 }));
    }
    throw new Error(`unexpected fetch URL: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
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

describe('POST /auth/apple authorizationCode', () => {
  it('exchanges and stores an Apple refresh token without changing the login response', async () => {
    const fetchMock = stubAppleEndpoints();
    const { app, db } = makeContext(siwaConfig);
    const response = await providerRequest(
      app,
      'apple',
      { subject: 'apple-refresh-success' },
      'coached_student',
      'authorization-code',
    );

    expect(response.status).toBe(200);
    const identity = await db
      .selectFrom('user_identities')
      .select('apple_refresh_token')
      .where('provider_uid', '=', 'apple-refresh-success')
      .executeTakeFirstOrThrow();
    expect(identity.apple_refresh_token).toBe('stored-apple-refresh-token');
    const tokenCall = fetchMock.mock.calls.find(
      ([input]) => requestUrl(input) === 'https://appleid.apple.com/auth/token',
    );
    const body = tokenCall?.[1]?.body as URLSearchParams;
    expect(body.get('code')).toBe('authorization-code');
  });

  it('logs in successfully when Apple token exchange fails', async () => {
    stubAppleEndpoints({ tokenStatus: 500 });
    const { app, db } = makeContext(siwaConfig);
    const response = await providerRequest(
      app,
      'apple',
      { subject: 'apple-refresh-failure' },
      'coached_student',
      'authorization-code',
    );

    expect(response.status).toBe(200);
    const identity = await db
      .selectFrom('user_identities')
      .select('apple_refresh_token')
      .where('provider_uid', '=', 'apple-refresh-failure')
      .executeTakeFirstOrThrow();
    expect(identity.apple_refresh_token).toBeNull();
  });

  it('logs in without calling the token endpoint when SIWA is not configured', async () => {
    const fetchMock = stubAppleEndpoints();
    const { app, db } = makeContext();
    const response = await providerRequest(
      app,
      'apple',
      { subject: 'apple-refresh-unconfigured' },
      'coached_student',
      'authorization-code',
    );

    expect(response.status).toBe(200);
    expect(
      fetchMock.mock.calls.some(
        ([input]) => requestUrl(input) === 'https://appleid.apple.com/auth/token',
      ),
    ).toBe(false);
    const identity = await db
      .selectFrom('user_identities')
      .select('apple_refresh_token')
      .where('provider_uid', '=', 'apple-refresh-unconfigured')
      .executeTakeFirstOrThrow();
    expect(identity.apple_refresh_token).toBeNull();
  });
});

describe('DELETE /me Apple revocation', () => {
  it.each([
    ['successful', 200],
    ['failed', 500],
  ] as const)('deletes the account after a %s Apple revoke response', async (_label, status) => {
    const fetchMock = stubAppleEndpoints({ revokeStatus: status });
    const { app, db } = makeContext(siwaConfig);
    const login = await providerRequest(
      app,
      'apple',
      { subject: `apple-delete-${String(status)}` },
      'coached_student',
      'authorization-code',
    );
    const deleted = await request(app)
      .delete('/me')
      .set('Authorization', `Bearer ${String(login.body.accessToken)}`);

    expect(deleted.status).toBe(204);
    expect(
      await db
        .selectFrom('users')
        .select('id')
        .where('id', '=', login.body.user.id as string)
        .executeTakeFirst(),
    ).toBeUndefined();
    const revokeCall = fetchMock.mock.calls.find(
      ([input]) => requestUrl(input) === 'https://appleid.apple.com/auth/revoke',
    );
    const body = revokeCall?.[1]?.body as URLSearchParams;
    expect(body.get('token')).toBe('stored-apple-refresh-token');
    expect(body.get('token_type_hint')).toBe('refresh_token');
  });

  it('deletes without a revoke call when SIWA is not configured', async () => {
    const fetchMock = stubAppleEndpoints();
    const { app, db } = makeContext();
    const login = await providerRequest(app, 'apple', { subject: 'apple-delete-unconfigured' });
    await db
      .updateTable('user_identities')
      .set({ apple_refresh_token: 'refresh-with-no-server-key' })
      .where('provider_uid', '=', 'apple-delete-unconfigured')
      .execute();

    const deleted = await request(app)
      .delete('/me')
      .set('Authorization', `Bearer ${String(login.body.accessToken)}`);
    expect(deleted.status).toBe(204);
    expect(
      fetchMock.mock.calls.some(
        ([input]) => requestUrl(input) === 'https://appleid.apple.com/auth/revoke',
      ),
    ).toBe(false);
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
    });
    expect(registration.status).toBe(201);
    expect(registration.body.user).toMatchObject({
      phone: null,
      email: 'student@example.com',
      role: 'coached_student',
    });
    expect(mem.public.one(`SELECT email, email_verified_at FROM users;`)).toEqual({
      email: 'student@example.com',
      email_verified_at: null,
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
