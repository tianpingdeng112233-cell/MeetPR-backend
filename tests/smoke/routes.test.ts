import jwt from 'jsonwebtoken';
import type { Kysely } from 'kysely';
import pino from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/app';
import type { Config } from '../../src/config';
import type { Database } from '../../src/db/types';

const baseConfig: Config = {
  NODE_ENV: 'test',
  PORT: 3000,
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_TTL: '30d',
  LOG_LEVEL: 'silent',
  RATE_LIMIT_WINDOW_MS: 60_000,
  RATE_LIMIT_MAX: 10_000,
  CORS_ORIGIN: '*',
  TRUST_PROXY: 0,
};

function makeDeps() {
  return {
    config: baseConfig,
    logger: pino({ level: 'silent' }),
    db: {} as unknown as Kysely<Database>,
  };
}

type Role = 'coach' | 'coached_student' | 'self_train_student';

function signValidToken(role: Role = 'coach'): string {
  return jwt.sign({ sub: 'user_test_1', role }, baseConfig.JWT_ACCESS_SECRET, {
    expiresIn: '15m',
  });
}

describe('auth endpoints — public validation', () => {
  it('POST /auth/register validates before DB access', async () => {
    const app = createApp(makeDeps());
    const res = await request(app).post('/auth/register').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('POST /auth/login validates before DB access', async () => {
    const app = createApp(makeDeps());
    const res = await request(app).post('/auth/login').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('POST /auth/refresh validates before DB access', async () => {
    const app = createApp(makeDeps());
    const res = await request(app).post('/auth/refresh').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });
});

describe('endpoint stubs — /me (protected)', () => {
  it('without token → 401', async () => {
    const app = createApp(makeDeps());
    const res = await request(app).get('/me');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'AUTH_INVALID_TOKEN' });
  });

  it('with valid token → 501', async () => {
    const app = createApp(makeDeps());
    const res = await request(app).get('/me').set('Authorization', `Bearer ${signValidToken()}`);
    expect(res.status).toBe(501);
  });

  it('with malformed Authorization header → 401', async () => {
    const app = createApp(makeDeps());
    const res = await request(app).get('/me').set('Authorization', 'NotBearer abc');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'AUTH_INVALID_TOKEN' });
  });

  it('with bogus JWT signature → 401', async () => {
    const app = createApp(makeDeps());
    const fake = jwt.sign({ sub: 'u1', role: 'coach' }, 'wrong-secret-too-short-but-different');
    const res = await request(app).get('/me').set('Authorization', `Bearer ${fake}`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'AUTH_INVALID_TOKEN' });
  });
});

describe('endpoint stubs — /coach/* (protected)', () => {
  it('GET /coach/dashboard: 401 without token, 501 with token', async () => {
    const app = createApp(makeDeps());
    const noTok = await request(app).get('/coach/dashboard');
    expect(noTok.status).toBe(401);
    const withTok = await request(app)
      .get('/coach/dashboard')
      .set('Authorization', `Bearer ${signValidToken()}`);
    expect(withTok.status).toBe(501);
  });

  it('GET /coach/students: 401 without token, 501 with token', async () => {
    const app = createApp(makeDeps());
    const noTok = await request(app).get('/coach/students');
    expect(noTok.status).toBe(401);
    const withTok = await request(app)
      .get('/coach/students')
      .set('Authorization', `Bearer ${signValidToken()}`);
    expect(withTok.status).toBe(501);
  });
});

describe('endpoint stubs — /student/* (protected)', () => {
  it('POST /student/sets: 401 without token, 501 with token', async () => {
    const app = createApp(makeDeps());
    const noTok = await request(app).post('/student/sets').send({});
    expect(noTok.status).toBe(401);
    const withTok = await request(app)
      .post('/student/sets')
      .set('Authorization', `Bearer ${signValidToken('coached_student')}`)
      .send({});
    expect(withTok.status).toBe(501);
  });
});
