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

  it('coerces numeric strings to numbers', () => {
    const config = loadConfig({ ...validEnv, PORT: '4000', RATE_LIMIT_MAX: '50' });
    expect(config.PORT).toBe(4000);
    expect(config.RATE_LIMIT_MAX).toBe(50);
  });

  it('exposes the schema as a named export', () => {
    expect(ConfigSchema).toBeDefined();
  });
});
