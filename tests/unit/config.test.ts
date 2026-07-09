import { describe, expect, it } from 'vitest';

import { ConfigSchema, loadConfig } from '../../src/config';

const validEnv: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
};

describe('config', () => {
  it('parses a valid environment with defaults', () => {
    const config = loadConfig(validEnv);
    expect(config.PORT).toBe(3000);
    expect(config.NODE_ENV).toBe('test');
    expect(config.JWT_ACCESS_TTL).toBe('15m');
    expect(config.JWT_REFRESH_TTL).toBe('30d');
    expect(config.RATE_LIMIT_MAX).toBe(100);
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('throws when DATABASE_URL is missing', () => {
    const { DATABASE_URL: _omit, ...rest } = validEnv;
    expect(() => loadConfig(rest)).toThrow();
  });

  it('throws when JWT_ACCESS_SECRET is too short', () => {
    expect(() => loadConfig({ ...validEnv, JWT_ACCESS_SECRET: 'short' })).toThrow();
  });

  it('throws when JWT_REFRESH_SECRET is too short', () => {
    expect(() => loadConfig({ ...validEnv, JWT_REFRESH_SECRET: 'short' })).toThrow();
  });

  it('rejects equal access and refresh secrets', () => {
    const secret = 'a'.repeat(48);
    expect(() =>
      loadConfig({ ...validEnv, JWT_ACCESS_SECRET: secret, JWT_REFRESH_SECRET: secret }),
    ).toThrow();
  });

  it('boots a pre-TLS production config but fails closed once FORCE_HTTPS is on', () => {
    // HTTPS is a go-live blocker, not a deploy gate: before FORCE_HTTPS the
    // HTTPS/CORS shape checks are skipped so a pre-TLS build still boots.
    const preTls = loadConfig({ ...validEnv, NODE_ENV: 'production' });
    expect(preTls.NODE_ENV).toBe('production');
    expect(preTls.FORCE_HTTPS).toBeUndefined();

    // With FORCE_HTTPS on, an incomplete TLS/CORS setup is rejected at boot.
    expect(() =>
      loadConfig({ ...validEnv, NODE_ENV: 'production', FORCE_HTTPS: 'true' }),
    ).toThrow();

    const config = loadConfig({
      ...validEnv,
      NODE_ENV: 'production',
      FORCE_HTTPS: 'true',
      CORS_ORIGIN: 'https://plan.example.test',
      PUBLIC_BASE_URL: 'https://api.example.test',
      TRUST_PROXY: '1',
    });
    expect(config.FORCE_HTTPS).toBe(true);
  });

  it('coerces numeric strings to numbers', () => {
    const config = loadConfig({ ...validEnv, PORT: '4000', RATE_LIMIT_MAX: '50' });
    expect(config.PORT).toBe(4000);
    expect(config.RATE_LIMIT_MAX).toBe(50);
  });

  it('exposes the schema as a named export', () => {
    expect(ConfigSchema).toBeDefined();
  });
});
