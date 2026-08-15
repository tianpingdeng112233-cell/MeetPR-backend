import cron from 'node-cron';
import type { Kysely } from 'kysely';

import type { Config } from '../config';
import type { Database } from '../db/types';
import { PUSH_POLICY } from '../domain/push-policy';
import { SIGNAL_POLICY } from '../domain/signal-policy';
import type { Logger } from '../logger';
import type { ApnsClient } from '../services/apns';
import { trainingDay, utcDate, utcDateOnly } from '../utils/date';
import { DEFAULT_TIME_ZONE } from '../utils/timezone';
import {
  expireOpenSignalsForTimeZone,
  runDailySettlement,
  runSessionSweep,
} from './activity-settlement';
import { runDailyDigest } from './daily-digest';
import { consumePushOutbox } from './push-consumer';

const SCHEDULER_TIME_ZONE = 'UTC';
const SESSION_SWEEP_CRON = '*/15 * * * *';

export interface SchedulerDeps {
  db: Kysely<Database>;
  logger: Logger;
  config: Pick<Config, 'SIGNALS_CRON_ENABLED' | 'PUSH_ENABLED' | 'PUSH_DAILY_DIGEST_ENABLED'>;
}

export interface ActivityScheduler {
  stop(): void;
}

export type SchedulerFactory = (deps: SchedulerDeps) => ActivityScheduler;

export interface PushSchedulerDeps {
  db: Kysely<Database>;
  logger: Logger;
  config: Pick<Config, 'PUSH_ENABLED' | 'PUSH_DAILY_DIGEST_ENABLED'>;
  apnsClient?: ApnsClient | undefined;
}

export type PushSchedulerFactory = (deps: PushSchedulerDeps) => ActivityScheduler;

export function justClosedGymDay(now: Date, timezone = DEFAULT_TIME_ZONE): string {
  const date = utcDate(trainingDay(now, timezone));
  date.setUTCDate(date.getUTCDate() - 1);
  return utcDateOnly(date);
}

export function gymDaysToReview(now: Date, timezone = DEFAULT_TIME_ZONE): string[] {
  const latest = utcDate(justClosedGymDay(now, timezone));
  return Array.from({ length: 3 }, (_, index) => {
    const day = new Date(latest);
    day.setUTCDate(day.getUTCDate() - index);
    return utcDateOnly(day);
  });
}

export function localHour(now: Date, timezone: string): number {
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(now)
    .find((part) => part.type === 'hour')?.value;
  if (hour === undefined) throw new Error(`Unable to derive local hour for ${timezone}`);
  return Number(hour);
}

/** One UTC hourly pass over every timezone that currently owns a user row. */
export async function runTimeZoneBuckets(deps: SchedulerDeps, now = new Date()): Promise<void> {
  const timezoneRows = await deps.db
    .selectFrom('users')
    .select('timezone')
    .distinct()
    .orderBy('timezone')
    .execute();

  const buckets = timezoneRows.map(({ timezone }) => ({
    timezone,
    hour: localHour(now, timezone),
    gymDays: gymDaysToReview(now, timezone),
  }));

  // Phase one must finish every timezone before any coach digest starts. This
  // ordering is global, because a coach and student can live in different
  // timezone buckets.
  const failedStudentIds = new Set<string>();
  if (deps.config.SIGNALS_CRON_ENABLED) {
    for (const bucket of buckets) {
      for (const gymDay of bucket.gymDays) {
        try {
          const failedInSettlement = await runDailySettlement(
            deps.db,
            gymDay,
            now,
            deps.logger,
            deps.config.PUSH_ENABLED,
            bucket.timezone,
          );
          for (const studentId of failedInSettlement) failedStudentIds.add(studentId);
        } catch (err) {
          deps.logger.error(
            { err, gymDay, timezone: bucket.timezone },
            'timezone_bucket_settlement_failed',
          );
        }
      }
    }

    // Expiry intentionally retains the legacy once-per-local-day 04:05
    // cadence. It is not part of each hourly settlement pass or 3-day replay.
    for (const bucket of buckets) {
      if (bucket.hour !== 4) continue;
      try {
        await expireOpenSignalsForTimeZone(deps.db, now, deps.logger, bucket.timezone);
      } catch (err) {
        deps.logger.error(
          { err, timezone: bucket.timezone },
          'timezone_bucket_signal_expiry_failed',
        );
      }
    }
  }

  // PUSH_DAILY_DIGEST_ENABLED remains independent of SIGNALS_CRON_ENABLED,
  // preserving the pre-timezone scheduler's feature-gate semantics.
  if (deps.config.PUSH_DAILY_DIGEST_ENABLED) {
    for (const bucket of buckets) {
      if (bucket.hour < 8) continue;
      // Digest uses ONLY the newest key. Replaying older keys here would let a
      // coach whose newest key already has an outbox row re-consume the same
      // watermark window under an older aggregate_id — a duplicate push with a
      // wrong gym_day label. Catch-up after downtime rides the watermark
      // window instead: pending student days accumulate and ship under the
      // next successful newest-key digest.
      const gymDay = bucket.gymDays[0];
      if (gymDay === undefined) continue;
      try {
        await runDailyDigest(deps.db, gymDay, now, deps.logger, bucket.timezone, failedStudentIds);
      } catch (err) {
        deps.logger.error(
          { err, gymDay, timezone: bucket.timezone },
          'timezone_bucket_digest_failed',
        );
      }
    }
  }
}

export function createActivityScheduler(deps: SchedulerDeps): ActivityScheduler {
  const tasks: { stop(): unknown }[] = [];
  tasks.push(
    cron.schedule(
      SIGNAL_POLICY.timeZoneBucketCron,
      async () => {
        try {
          await runTimeZoneBuckets(deps);
        } catch (err) {
          deps.logger.error({ err }, 'timezone_bucket_runner_failed');
        }
      },
      { timezone: SCHEDULER_TIME_ZONE, noOverlap: true },
    ),
  );
  if (deps.config.SIGNALS_CRON_ENABLED) {
    tasks.push(
      cron.schedule(
        SESSION_SWEEP_CRON,
        async () => {
          const now = new Date();
          try {
            await runSessionSweep(deps.db, now);
          } catch (err) {
            deps.logger.error({ err }, 'activity_session_sweep_failed');
          }
        },
        { timezone: SCHEDULER_TIME_ZONE, noOverlap: true },
      ),
    );
  }

  return {
    stop(): void {
      for (const task of tasks) void task.stop();
    },
  };
}

export function startActivityScheduler(
  deps: SchedulerDeps,
  factory: SchedulerFactory = createActivityScheduler,
): ActivityScheduler | null {
  if (!deps.config.SIGNALS_CRON_ENABLED && !deps.config.PUSH_DAILY_DIGEST_ENABLED) return null;
  return factory(deps);
}

export function createPushConsumerScheduler(deps: PushSchedulerDeps): ActivityScheduler {
  const tasks: { stop(): unknown }[] = [];
  if (deps.config.PUSH_ENABLED) {
    if (deps.apnsClient === undefined) {
      throw new Error('apnsClient is required when PUSH_ENABLED=true');
    }
    const apnsClient = deps.apnsClient;
    tasks.push(
      cron.schedule(
        PUSH_POLICY.consumerCron,
        async () => {
          const now = new Date();
          try {
            await consumePushOutbox(deps.db, apnsClient, now, deps.logger);
          } catch (err) {
            deps.logger.error({ err }, 'push_outbox_consumer_failed');
          }
        },
        // noOverlap: a slow APNs batch must skip the next tick instead of stacking
        // concurrent consumers on the same rows.
        { timezone: SCHEDULER_TIME_ZONE, noOverlap: true },
      ),
    );
  }

  return {
    stop(): void {
      for (const task of tasks) void task.stop();
    },
  };
}

export function startPushConsumerScheduler(
  deps: PushSchedulerDeps,
  factory: PushSchedulerFactory = createPushConsumerScheduler,
): ActivityScheduler | null {
  if (!deps.config.PUSH_ENABLED) return null;
  return factory(deps);
}
