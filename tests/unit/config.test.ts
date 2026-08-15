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
    expect(config.PUSH_ENABLED).toBe(false);
    expect(config.PUSH_DAILY_DIGEST_ENABLED).toBe(false);
    expect(config.SELF_SIGNUP_ROLES).toBeUndefined();
    expect(config.APPLE_CLIENT_ID).toBeUndefined();
    expect(config.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(config.OSS_ACCELERATE_ENDPOINT).toBeUndefined();
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

  it('requires an allowlist if production self-registration is enabled', () => {
    expect(() =>
      loadConfig({
        ...validEnv,
        NODE_ENV: 'production',
        CORS_ORIGIN: 'https://plan.example.test',
        PUBLIC_BASE_URL: 'https://api.example.test',
        TRUST_PROXY: '1',
        REGISTRATION_ENABLED: 'true',
      }),
    ).toThrow();
  });

  it('coerces numeric strings to numbers', () => {
    const config = loadConfig({ ...validEnv, PORT: '4000', RATE_LIMIT_MAX: '50' });
    expect(config.PORT).toBe(4000);
    expect(config.RATE_LIMIT_MAX).toBe(50);
  });

  it('accepts an optional OSS transfer-acceleration endpoint', () => {
    const config = loadConfig({
      ...validEnv,
      OSS_ACCELERATE_ENDPOINT: 'https://oss-accelerate.aliyuncs.com',
    });

    expect(config.OSS_ACCELERATE_ENDPOINT).toBe('https://oss-accelerate.aliyuncs.com');
  });

  it('requires every APNs setting when push is enabled', () => {
    const result = ConfigSchema.safeParse({ ...validEnv, PUSH_ENABLED: 'true' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.flatten().fieldErrors).toMatchObject({
      APNS_KEY: expect.any(Array),
      APNS_KEY_ID: expect.any(Array),
      APNS_TEAM_ID: expect.any(Array),
      APNS_BUNDLE_ID: expect.any(Array),
      APNS_ENV: expect.any(Array),
    });
  });

  it('accepts a complete APNs configuration when push is enabled', () => {
    const config = loadConfig({
      ...validEnv,
      PUSH_ENABLED: 'true',
      APNS_KEY: 'pem-content',
      APNS_KEY_ID: 'key-id',
      APNS_TEAM_ID: 'team-id',
      APNS_BUNDLE_ID: 'com.example.meetpr',
      APNS_ENV: 'sandbox',
    });
    expect(config.PUSH_ENABLED).toBe(true);
    expect(config.APNS_ENV).toBe('sandbox');
  });

  it('accepts only student roles in the global self-signup gate', () => {
    const config = loadConfig({
      ...validEnv,
      SELF_SIGNUP_ROLES: 'coached_student,self_train_student',
    });
    expect(config.SELF_SIGNUP_ROLES).toBe('coached_student,self_train_student');
    expect(() => loadConfig({ ...validEnv, SELF_SIGNUP_ROLES: 'coach' })).toThrow();
  });

  it('exposes the schema as a named export', () => {
    expect(ConfigSchema).toBeDefined();
  });
});
