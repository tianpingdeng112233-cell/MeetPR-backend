import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config';
import { makeContext } from './helpers/studentActions';

const env = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
};

describe('minimum version configuration', () => {
  it('defaults both platforms to zero', () => {
    expect(loadConfig(env)).toMatchObject({ MIN_IOS_BUILD: 0, MIN_ANDROID_VERSION_CODE: 0 });
  });
  it('parses configured nonnegative integers', () => {
    expect(
      loadConfig({ ...env, MIN_IOS_BUILD: '28', MIN_ANDROID_VERSION_CODE: '100' }),
    ).toMatchObject({ MIN_IOS_BUILD: 28, MIN_ANDROID_VERSION_CODE: 100 });
  });
  it.each(['MIN_IOS_BUILD', 'MIN_ANDROID_VERSION_CODE'])('rejects invalid %s', (name) => {
    for (const value of ['-1', '1.5', 'abc', 'Infinity']) {
      expect(() => loadConfig({ ...env, [name]: value })).toThrow();
    }
  });
});

describe('GET /app/min-version', () => {
  it.each(['ios', 'android'])(
    'returns zero for unconfigured %s without auth and caches for 300 seconds',
    async (platform) => {
      const { app } = await makeContext();
      const response = await request(app).get(`/app/min-version?platform=${platform}`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ min_build: 0 });
      expect(response.headers['cache-control']).toBe('max-age=300');
    },
  );
  it.each([
    ['ios', 28],
    ['android', 100],
  ])('returns the configured minimum for %s', async (platform, min_build) => {
    const { app } = await makeContext(undefined, {
      config: loadConfig({ ...env, MIN_IOS_BUILD: '28', MIN_ANDROID_VERSION_CODE: '100' }),
    });
    const response = await request(app).get(`/app/min-version?platform=${platform}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ min_build });
    expect(response.headers['cache-control']).toBe('max-age=300');
  });
  it.each([
    '',
    '?platform=web',
    '?platform=IOS',
    '?platform=ios&platform=android',
    '?platform[x]=ios',
  ])('rejects an invalid platform query %s', async (query) => {
    const { app } = await makeContext();
    const response = await request(app).get(`/app/min-version${query}`);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'INVALID_PLATFORM' });
  });
});
