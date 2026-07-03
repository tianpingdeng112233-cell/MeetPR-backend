import { describe, expect, it } from 'vitest';

import { ConfigSchema } from '../src/config';

const base = {
  DATABASE_URL: 'postgres://t:t@localhost:5432/t',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
  JWT_REFRESH_SECRET: 'y'.repeat(32),
};

describe('analytics config', () => {
  it('parses ANALYTICS_ENABLED="false" to boolean false (kill-switch really turns off)', () => {
    // The whole point of §11: z.coerce.boolean('false') === true would wedge the
    // kill-switch permanently on. The enum().transform must yield actual false.
    const cfg = ConfigSchema.parse({ ...base, ANALYTICS_ENABLED: 'false' });
    expect(cfg.ANALYTICS_ENABLED).toBe(false);
  });

  it('defaults ANALYTICS_ENABLED to true and ANALYTICS_SAMPLE_RATE to 1', () => {
    const cfg = ConfigSchema.parse(base);
    expect(cfg.ANALYTICS_ENABLED).toBe(true);
    expect(cfg.ANALYTICS_SAMPLE_RATE).toBe(1);
  });

  it('defaults the dedicated events limiter window/max', () => {
    const cfg = ConfigSchema.parse(base);
    expect(cfg.EVENTS_RATE_LIMIT_WINDOW_MS).toBe(60_000);
    expect(cfg.EVENTS_RATE_LIMIT_MAX).toBe(600);
  });
});
