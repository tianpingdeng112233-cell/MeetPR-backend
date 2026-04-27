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

describe('endpoint stubs — auth (public)', () => {
  it('POST /auth/register → 501', async () => {
    const app = createApp(makeDeps());
    const res = await request(app).post('/auth/register').send({});
    expect(res.status).toBe(501);
    expect(res.body).toEqual({ error: 'not_implemented', endpoint: 'POST /auth/register' });
  });

  it('POST /auth/login → 501', async () => {
    const app = createApp(makeDeps());
    const res = await request(app).post('/auth/login').send({});
    expect(res.status).toBe(501);
  });

  it('POST /auth/refresh → 501', async () => {
    const app = createApp(makeDeps());
    const res = await request(app).post('/auth/refresh').send({});
    expect(res.status).toBe(501);
  });
});

describe('endpoint stubs — /me (protected)', () => {
  it('without token → 401', async () => {
    const app = createApp(makeDeps());
    const res = await request(app).get('/me');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
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
  });

  it('with bogus JWT signature → 401', async () => {
    const app = createApp(makeDeps());
    const fake = jwt.sign({ sub: 'u1', role: 'coach' }, 'wrong-secret-too-short-but-different');
    const res = await request(app).get('/me').set('Authorization', `Bearer ${fake}`);
    expect(res.status).toBe(401);
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

  it('POST /coach/plans: 401 without token, 501 with token', async () => {
    const app = createApp(makeDeps());
    const noTok = await request(app).post('/coach/plans').send({});
    expect(noTok.status).toBe(401);
    const withTok = await request(app)
      .post('/coach/plans')
      .set('Authorization', `Bearer ${signValidToken()}`)
      .send({});
    expect(withTok.status).toBe(501);
  });
});

describe('endpoint stubs — /student/* (protected)', () => {
  it('GET /student/plan: 401 without token, 501 with token', async () => {
    const app = createApp(makeDeps());
    const noTok = await request(app).get('/student/plan');
    expect(noTok.status).toBe(401);
    const withTok = await request(app)
      .get('/student/plan')
      .set('Authorization', `Bearer ${signValidToken('coached_student')}`);
    expect(withTok.status).toBe(501);
  });

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
