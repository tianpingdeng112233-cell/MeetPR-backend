import type { Kysely } from 'kysely';
import pino from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/app';
import type { Config } from '../../src/config';
import type { Database } from '../../src/db/types';

function makeDeps() {
  const config: Config = {
    NODE_ENV: 'test',
    PORT: 3000,
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    JWT_ACCESS_TTL: '15m',
    JWT_REFRESH_TTL: '30d',
    LOG_LEVEL: 'silent',
    RATE_LIMIT_WINDOW_MS: 60_000,
    RATE_LIMIT_MAX: 1000,
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
  return {
    config,
    logger: pino({ level: 'silent' }),
    db: {} as unknown as Kysely<Database>,
  };
}

describe('app', () => {
  it('returns 200 with status ok on /health', async () => {
    const app = createApp(makeDeps());
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('echoes X-Request-Id header on the response', async () => {
    const app = createApp(makeDeps());
    const res = await request(app).get('/health').set('X-Request-Id', 'test-req-1');
    expect(res.headers['x-request-id']).toBe('test-req-1');
  });

  it('generates a request id when none is provided', async () => {
    const app = createApp(makeDeps());
    const res = await request(app).get('/health');
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(typeof res.headers['x-request-id']).toBe('string');
  });

  it('returns 404 JSON envelope for unknown routes', async () => {
    const app = createApp(makeDeps());
    const res = await request(app).get('/no-such-path');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found', path: '/no-such-path' });
  });

  it('fails closed for direct HTTP once FORCE_HTTPS is on while accepting trusted HTTPS proxy traffic', async () => {
    const deps = makeDeps();
    deps.config = {
      ...deps.config,
      NODE_ENV: 'production',
      FORCE_HTTPS: true,
      CORS_ORIGIN: 'https://plan.example.test',
      PUBLIC_BASE_URL: 'https://api.example.test',
      TRUST_PROXY: 1,
    };
    const app = createApp(deps);

    const directHttp = await request(app).post('/auth/login').send({});
    expect(directHttp.status).toBe(426);
    expect(directHttp.body).toEqual({ error: 'HTTPS_REQUIRED' });

    const proxiedHttps = await request(app)
      .post('/auth/login')
      .set('X-Forwarded-Proto', 'https')
      .send({});
    expect(proxiedHttps.status).toBe(400);
    expect(proxiedHttps.body.error).toBe('VALIDATION_ERROR');
  });

  it('serves HTTP normally in production while FORCE_HTTPS is off (pre-TLS go-live)', async () => {
    const deps = makeDeps();
    deps.config = { ...deps.config, NODE_ENV: 'production' };
    const app = createApp(deps);

    const directHttp = await request(app).post('/auth/login').send({});
    expect(directHttp.status).not.toBe(426);
    expect(directHttp.status).toBe(400);
    expect(directHttp.body.error).toBe('VALIDATION_ERROR');
  });
});
