import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { ConfigSchema } from '../../src/config';
import type { Database } from '../../src/db/types';
import { PUSH_POLICY } from '../../src/domain/push-policy';
import {
  justClosedGymDay,
  startActivityScheduler,
  startPushConsumerScheduler,
  type PushSchedulerDeps,
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

describe('push consumer cron registration', () => {
  it('registers digest and consumer with Shanghai timezone and noOverlap', async () => {
    vi.resetModules();
    const schedule = vi.fn(() => ({ stop: vi.fn() }));
    vi.doMock('node-cron', () => ({ default: { schedule } }));
    const { createPushConsumerScheduler } = await import('../../src/jobs/scheduler');

    createPushConsumerScheduler({
      db: {} as Kysely<Database>,
      logger: {} as Logger,
      config: { PUSH_ENABLED: true },
      apnsClient: { send: vi.fn() },
    });

    expect(schedule).toHaveBeenCalledTimes(2);
    expect(schedule).toHaveBeenNthCalledWith(
      1,
      PUSH_POLICY.dailyDigestCron,
      expect.any(Function),
      expect.objectContaining({ timezone: 'Asia/Shanghai', noOverlap: true }),
    );
    expect(schedule).toHaveBeenNthCalledWith(
      2,
      PUSH_POLICY.consumerCron,
      expect.any(Function),
      expect.objectContaining({ timezone: 'Asia/Shanghai', noOverlap: true }),
    );
    vi.doUnmock('node-cron');
    vi.resetModules();
  });
});

describe('push consumer scheduler gate', () => {
  function pushDeps(enabled: boolean): PushSchedulerDeps {
    return {
      db: {} as Kysely<Database>,
      logger: {} as Logger,
      config: { PUSH_ENABLED: enabled },
      apnsClient: { send: vi.fn() },
    };
  }

  it('does not mount the consumer cron while push is disabled', () => {
    const factory = vi.fn(() => ({ stop: vi.fn() }));
    expect(startPushConsumerScheduler(pushDeps(false), factory)).toBeNull();
    expect(factory).not.toHaveBeenCalled();
  });

  it('mounts independently when push is enabled', () => {
    const task = { stop: vi.fn() };
    const factory = vi.fn(() => task);
    expect(startPushConsumerScheduler(pushDeps(true), factory)).toBe(task);
    expect(factory).toHaveBeenCalledOnce();
  });
});
