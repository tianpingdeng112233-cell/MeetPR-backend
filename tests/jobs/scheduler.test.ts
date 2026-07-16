import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { ConfigSchema } from '../../src/config';
import type { Database } from '../../src/db/types';
import {
  justClosedGymDay,
  startActivityScheduler,
  type SchedulerDeps,
} from '../../src/jobs/scheduler';

const baseEnv = {
  DATABASE_URL: 'postgres://t:t@localhost:5432/t',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
  JWT_REFRESH_SECRET: 'y'.repeat(32),
};

function deps(enabled: boolean): SchedulerDeps {
  return {
    db: {} as Kysely<Database>,
    logger: {} as Logger,
    config: { SIGNALS_CRON_ENABLED: enabled },
  };
}

describe('activity scheduler gate', () => {
  it('defaults the env gate to true and parses the literal false correctly', () => {
    expect(ConfigSchema.parse(baseEnv).SIGNALS_CRON_ENABLED).toBe(true);
    expect(
      ConfigSchema.parse({ ...baseEnv, SIGNALS_CRON_ENABLED: 'false' }).SIGNALS_CRON_ENABLED,
    ).toBe(false);
  });

  it('does not mount cron tasks while the gate is off', () => {
    const factory = vi.fn(() => ({ stop: vi.fn() }));
    expect(startActivityScheduler(deps(false), factory)).toBeNull();
    expect(factory).not.toHaveBeenCalled();
  });

  it('targets the gym-day that closed immediately before the Shanghai 04:05 run', () => {
    expect(justClosedGymDay(new Date('2026-07-15T20:05:00Z'))).toBe('2026-07-15');
  });
});
