import type { Kysely } from 'kysely';
import pino, { type Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { ConfigSchema } from '../../src/config';
import type { Database } from '../../src/db/types';
import { PUSH_POLICY } from '../../src/domain/push-policy';
import { SIGNAL_POLICY } from '../../src/domain/signal-policy';
import { deriveDailyDigestAggregateId } from '../../src/jobs/daily-digest';
import {
  gymDaysToReview,
  justClosedGymDay,
  localHour,
  runTimeZoneBuckets,
  startActivityScheduler,
  startPushConsumerScheduler,
  type PushSchedulerDeps,
  type SchedulerDeps,
} from '../../src/jobs/scheduler';
import { createPublishedPlan, ids, makeContext } from '../helpers/studentActions';

const baseEnv = {
  DATABASE_URL: 'postgres://t:t@localhost:5432/t',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
  JWT_REFRESH_SECRET: 'y'.repeat(32),
};

function deps(signalsEnabled: boolean, digestEnabled = false): SchedulerDeps {
  return {
    db: {} as Kysely<Database>,
    logger: {} as Logger,
    config: {
      SIGNALS_CRON_ENABLED: signalsEnabled,
      PUSH_ENABLED: false,
      PUSH_DAILY_DIGEST_ENABLED: digestEnabled,
    },
  };
}

describe('timezone bucket scheduler', () => {
  it('defaults the env gate to true and parses the literal false correctly', () => {
    expect(ConfigSchema.parse(baseEnv).SIGNALS_CRON_ENABLED).toBe(true);
    expect(
      ConfigSchema.parse({ ...baseEnv, SIGNALS_CRON_ENABLED: 'false' }).SIGNALS_CRON_ENABLED,
    ).toBe(false);
  });

  it('does not mount cron tasks while settlement and digest gates are both off', () => {
    const factory = vi.fn(() => ({ stop: vi.fn() }));
    expect(startActivityScheduler(deps(false), factory)).toBeNull();
    expect(factory).not.toHaveBeenCalled();
  });

  it('mounts for digest-only operation without requiring the settlement gate', () => {
    const task = { stop: vi.fn() };
    const factory = vi.fn(() => task);
    expect(startActivityScheduler(deps(false, true), factory)).toBe(task);
  });

  it.each([
    ['Asia/Shanghai', '2026-07-15T20:05:00Z', '2026-07-15'],
    ['Europe/London', '2026-01-16T04:05:00Z', '2026-01-15'],
    ['Europe/London', '2026-07-16T03:05:00Z', '2026-07-15'],
    ['America/New_York', '2026-07-16T08:05:00Z', '2026-07-15'],
  ])('derives the just-closed gym-day in %s', (timezone, instant, expected) => {
    expect(justClosedGymDay(new Date(instant), timezone)).toBe(expected);
  });

  it('reviews the latest three closed gym-days newest first', () => {
    expect(gymDaysToReview(new Date('2026-07-17T00:05:00Z'), 'Asia/Shanghai')).toEqual([
      '2026-07-16',
      '2026-07-15',
      '2026-07-14',
    ]);
  });

  it('derives local digest hours across GMT, BST, and UTC-west', () => {
    expect(localHour(new Date('2026-01-16T08:05:00Z'), 'Europe/London')).toBe(8);
    expect(localHour(new Date('2026-07-16T07:05:00Z'), 'Europe/London')).toBe(8);
    expect(localHour(new Date('2026-07-16T12:05:00Z'), 'America/New_York')).toBe(8);
  });

  it('recovers multi-day settlement and digest gaps, then stays idempotent', async () => {
    const ctx = await makeContext();
    await ctx.db
      .updateTable('users')
      .set({ timezone: 'Europe/London' })
      .where('id', 'in', [ids.coach, ids.trainee])
      .execute();
    const plan = await createPublishedPlan(ctx);
    await ctx.db
      .insertInto('plan_days')
      .values([
        { plan_id: plan.planId, day_of_week: 2, week_number: 1, sort_order: 2 },
        { plan_id: plan.planId, day_of_week: 3, week_number: 1, sort_order: 3 },
      ])
      .execute();
    const bucketDeps: SchedulerDeps = {
      db: ctx.db,
      logger: pino({ level: 'silent' }),
      config: {
        SIGNALS_CRON_ENABLED: true,
        PUSH_ENABLED: false,
        PUSH_DAILY_DIGEST_ENABLED: true,
      },
    };

    // The service missed the May 1-3 closes. At 07:05 BST the 3-day settlement
    // replay recovers the full streak, while digest waits for its own 08 gate.
    // The 08:05 and repeated 08:05 passes prove both recovery and idempotency.
    await runTimeZoneBuckets(bucketDeps, new Date('2026-05-04T06:05:00Z'));
    expect(await ctx.db.selectFrom('student_signals').select('id').execute()).toHaveLength(1);
    expect(
      await ctx.db
        .selectFrom('notification_outbox')
        .select('id')
        .where('event_type', '=', 'coach_daily_digest')
        .execute(),
    ).toHaveLength(0);

    const digestNow = new Date('2026-05-04T07:05:00Z');
    await runTimeZoneBuckets(bucketDeps, digestNow);
    await runTimeZoneBuckets(bucketDeps, digestNow);
    expect(await ctx.db.selectFrom('student_signals').select('id').execute()).toHaveLength(1);
    expect(
      await ctx.db
        .selectFrom('notification_outbox')
        .select(['aggregate_id', 'payload'])
        .where('event_type', '=', 'coach_daily_digest')
        .execute(),
    ).toEqual([
      expect.objectContaining({
        aggregate_id: deriveDailyDigestAggregateId(ids.coach, '2026-05-03'),
      }),
    ]);
  });

  it('folds every day after an existing watermark into one catch-up digest and stays idempotent', async () => {
    const ctx = await makeContext();
    await ctx.db
      .insertInto('student_events')
      .values(
        ['2026-07-14', '2026-07-15', '2026-07-16'].map((sessionDate) => ({
          student_id: ids.trainee,
          coach_id: ids.coach,
          event_type: 'session_completed' as const,
          session_date: sessionDate,
          occurred_at: new Date(`${sessionDate}T12:00:00Z`),
          payload: JSON.stringify({}),
          dedup_key: `session_completed:${ids.trainee}:${sessionDate}`,
        })),
      )
      .execute();
    await ctx.db
      .insertInto('digest_watermarks')
      .values({
        coach_id: ids.coach,
        student_id: ids.trainee,
        last_gym_day: '2026-07-13',
      })
      .execute();
    const bucketDeps: SchedulerDeps = {
      db: ctx.db,
      logger: pino({ level: 'silent' }),
      config: {
        SIGNALS_CRON_ENABLED: false,
        PUSH_ENABLED: false,
        PUSH_DAILY_DIGEST_ENABLED: true,
      },
    };
    const catchUpNow = new Date('2026-07-17T00:05:00Z');

    // Digest remains independently gated when settlement is disabled, as it
    // was before the timezone runner, and folds all days after the watermark
    // into the newest coach-day key.
    await runTimeZoneBuckets(bucketDeps, catchUpNow);
    await runTimeZoneBuckets(bucketDeps, catchUpNow);

    const rows = await ctx.db
      .selectFrom('notification_outbox')
      .select(['aggregate_id', 'payload'])
      .where('event_type', '=', 'coach_daily_digest')
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.aggregate_id).toBe(deriveDailyDigestAggregateId(ids.coach, '2026-07-16'));
    const payload = (
      typeof rows[0]?.payload === 'string' ? JSON.parse(rows[0].payload) : rows[0]?.payload
    ) as { counts: { session_completed: number } };
    expect(payload.counts.session_completed).toBe(3);
    expect(
      await ctx.db.selectFrom('digest_watermarks').select('last_gym_day').executeTakeFirstOrThrow(),
    ).toEqual({ last_gym_day: new Date('2026-07-16T00:00:00.000Z') });
  });

  it('skips a failed student without moving its watermark, then catches it up next pass', async () => {
    let armed = false;
    let failOneSettlement = true;
    const ctx = await makeContext(undefined, {
      afterQuery: (query) => {
        if (
          armed &&
          failOneSettlement &&
          query.includes('for update') &&
          query.includes('"users"')
        ) {
          failOneSettlement = false;
          throw new Error('student settlement failed');
        }
        return Promise.resolve();
      },
    });
    await ctx.db
      .insertInto('student_events')
      .values({
        student_id: ids.trainee,
        coach_id: ids.coach,
        event_type: 'session_completed',
        session_date: '2026-05-03',
        occurred_at: new Date('2026-05-03T12:00:00Z'),
        payload: JSON.stringify({}),
        dedup_key: `session_completed:${ids.trainee}:2026-05-03`,
      })
      .execute();
    const bucketDeps: SchedulerDeps = {
      db: ctx.db,
      logger: pino({ level: 'silent' }),
      config: {
        SIGNALS_CRON_ENABLED: true,
        PUSH_ENABLED: false,
        PUSH_DAILY_DIGEST_ENABLED: true,
      },
    };
    const passNow = new Date('2026-05-04T00:05:00Z');
    armed = true;

    await runTimeZoneBuckets(bucketDeps, passNow);

    expect(failOneSettlement).toBe(false);
    expect(await ctx.db.selectFrom('notification_outbox').select('id').execute()).toEqual([]);
    expect(await ctx.db.selectFrom('digest_watermarks').selectAll().execute()).toEqual([]);

    await runTimeZoneBuckets(bucketDeps, passNow);

    const row = await ctx.db
      .selectFrom('notification_outbox')
      .select('payload')
      .where('event_type', '=', 'coach_daily_digest')
      .executeTakeFirstOrThrow();
    const payload = (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as {
      counts: { session_completed: number };
    };
    expect(payload.counts.session_completed).toBe(1);
    expect(
      await ctx.db
        .selectFrom('digest_watermarks')
        .select(['coach_id', 'student_id', 'last_gym_day'])
        .executeTakeFirstOrThrow(),
    ).toEqual({
      coach_id: ids.coach,
      student_id: ids.trainee,
      last_gym_day: new Date('2026-05-03T00:00:00.000Z'),
    });
  });

  it('registers the bucket runner hourly in UTC and keeps the session sweep', async () => {
    vi.resetModules();
    const schedule = vi.fn(() => ({ stop: vi.fn() }));
    vi.doMock('node-cron', () => ({ default: { schedule } }));
    const { createActivityScheduler } = await import('../../src/jobs/scheduler');

    createActivityScheduler(deps(true, true));

    expect(schedule).toHaveBeenCalledTimes(2);
    expect(schedule).toHaveBeenNthCalledWith(
      1,
      SIGNAL_POLICY.timeZoneBucketCron,
      expect.any(Function),
      { timezone: 'UTC', noOverlap: true },
    );
    expect(schedule).toHaveBeenNthCalledWith(2, '*/15 * * * *', expect.any(Function), {
      timezone: 'UTC',
      noOverlap: true,
    });
    vi.doUnmock('node-cron');
    vi.resetModules();
  });

  it('finishes every timezone settlement before starting any digest', async () => {
    vi.resetModules();
    const calls: string[] = [];
    const runDailySettlement = vi.fn((...args: unknown[]) => {
      calls.push(`settlement:${String(args[5])}:${String(args[1])}`);
      return Promise.resolve([]);
    });
    const runDailyDigest = vi.fn((...args: unknown[]) => {
      calls.push(`digest:${String(args[4])}:${String(args[1])}`);
      return Promise.resolve();
    });
    vi.doMock('../../src/jobs/activity-settlement', () => ({
      expireOpenSignalsForTimeZone: vi.fn(),
      runDailySettlement,
      runSessionSweep: vi.fn(),
    }));
    vi.doMock('../../src/jobs/daily-digest', () => ({ runDailyDigest }));
    const { runTimeZoneBuckets } = await import('../../src/jobs/scheduler');
    const query = {
      select: vi.fn(),
      distinct: vi.fn(),
      orderBy: vi.fn(),
      execute: vi
        .fn()
        .mockResolvedValue([{ timezone: 'Asia/Shanghai' }, { timezone: 'Europe/London' }]),
    };
    query.select.mockReturnValue(query);
    query.distinct.mockReturnValue(query);
    query.orderBy.mockReturnValue(query);
    const db = { selectFrom: vi.fn(() => query) } as unknown as Kysely<Database>;
    const logger = { error: vi.fn() } as unknown as Logger;

    await runTimeZoneBuckets(
      {
        db,
        logger,
        config: {
          SIGNALS_CRON_ENABLED: true,
          PUSH_ENABLED: false,
          PUSH_DAILY_DIGEST_ENABLED: true,
        },
      },
      new Date('2026-01-16T08:05:00Z'),
    );

    expect(calls).toEqual([
      'settlement:Asia/Shanghai:2026-01-15',
      'settlement:Asia/Shanghai:2026-01-14',
      'settlement:Asia/Shanghai:2026-01-13',
      'settlement:Europe/London:2026-01-15',
      'settlement:Europe/London:2026-01-14',
      'settlement:Europe/London:2026-01-13',
      // Digest never replays older keys: a coach whose newest key already has
      // an outbox row must not have the same watermark window re-consumed
      // under an older aggregate_id (duplicate push, wrong gym_day label).
      'digest:Asia/Shanghai:2026-01-15',
      'digest:Europe/London:2026-01-15',
    ]);
    vi.doUnmock('../../src/jobs/activity-settlement');
    vi.doUnmock('../../src/jobs/daily-digest');
    vi.resetModules();
  });

  it('runs Shanghai signal expiry only in the local 04 bucket, once per pass', async () => {
    vi.resetModules();
    const expireOpenSignalsForTimeZone = vi.fn(() => Promise.resolve());
    vi.doMock('../../src/jobs/activity-settlement', () => ({
      expireOpenSignalsForTimeZone,
      runDailySettlement: vi.fn(() => Promise.resolve([])),
      runSessionSweep: vi.fn(),
    }));
    vi.doMock('../../src/jobs/daily-digest', () => ({ runDailyDigest: vi.fn() }));
    const { runTimeZoneBuckets } = await import('../../src/jobs/scheduler');
    const query = {
      select: vi.fn(),
      distinct: vi.fn(),
      orderBy: vi.fn(),
      execute: vi.fn().mockResolvedValue([{ timezone: 'Asia/Shanghai' }]),
    };
    query.select.mockReturnValue(query);
    query.distinct.mockReturnValue(query);
    query.orderBy.mockReturnValue(query);
    const db = { selectFrom: vi.fn(() => query) } as unknown as Kysely<Database>;
    const logger = { error: vi.fn() } as unknown as Logger;
    const expiryDeps: SchedulerDeps = {
      db,
      logger,
      config: {
        SIGNALS_CRON_ENABLED: true,
        PUSH_ENABLED: false,
        PUSH_DAILY_DIGEST_ENABLED: false,
      },
    };

    await runTimeZoneBuckets(expiryDeps, new Date('2026-07-15T20:05:00Z'));
    await runTimeZoneBuckets(expiryDeps, new Date('2026-07-15T21:05:00Z'));

    expect(expireOpenSignalsForTimeZone).toHaveBeenCalledOnce();
    expect(expireOpenSignalsForTimeZone).toHaveBeenCalledWith(
      db,
      new Date('2026-07-15T20:05:00Z'),
      logger,
      'Asia/Shanghai',
    );
    vi.doUnmock('../../src/jobs/activity-settlement');
    vi.doUnmock('../../src/jobs/daily-digest');
    vi.resetModules();
  });
});

describe('push consumer cron registration', () => {
  it('registers only the APNs consumer in UTC with noOverlap', async () => {
    vi.resetModules();
    const schedule = vi.fn(() => ({ stop: vi.fn() }));
    vi.doMock('node-cron', () => ({ default: { schedule } }));
    const { createPushConsumerScheduler } = await import('../../src/jobs/scheduler');

    createPushConsumerScheduler({
      db: {} as Kysely<Database>,
      logger: {} as Logger,
      config: { PUSH_ENABLED: true, PUSH_DAILY_DIGEST_ENABLED: true },
      apnsClient: { send: vi.fn() },
    });

    expect(schedule).toHaveBeenCalledOnce();
    expect(schedule).toHaveBeenCalledWith(PUSH_POLICY.consumerCron, expect.any(Function), {
      timezone: 'UTC',
      noOverlap: true,
    });
    vi.doUnmock('node-cron');
    vi.resetModules();
  });
});

describe('push consumer scheduler gate', () => {
  function pushDeps(enabled: boolean): PushSchedulerDeps {
    return {
      db: {} as Kysely<Database>,
      logger: {} as Logger,
      config: { PUSH_ENABLED: enabled, PUSH_DAILY_DIGEST_ENABLED: false },
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

  it('does not mount for digest-only operation because digest lives in the bucket runner', () => {
    const factory = vi.fn(() => ({ stop: vi.fn() }));
    const digestOnly = pushDeps(false);
    digestOnly.config.PUSH_DAILY_DIGEST_ENABLED = true;
    expect(startPushConsumerScheduler(digestOnly, factory)).toBeNull();
    expect(factory).not.toHaveBeenCalled();
  });
});
