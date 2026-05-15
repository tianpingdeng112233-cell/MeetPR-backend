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
    TRUST_PROXY: 0,
    OSS_ACCESS_KEY_ID: 'test-access-key-id',
    OSS_ACCESS_KEY_SECRET: 'test-access-key-secret',
    OSS_BUCKET: 'meetpr-videos-prod',
    OSS_REGION: 'oss-cn-hangzhou',
    OSS_ENDPOINT: 'https://oss-cn-hangzhou.aliyuncs.com',
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
});
