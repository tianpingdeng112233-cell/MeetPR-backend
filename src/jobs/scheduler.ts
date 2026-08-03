import cron from 'node-cron';
import type { Kysely } from 'kysely';

import type { Config } from '../config';
import type { Database } from '../db/types';
import { PUSH_POLICY } from '../domain/push-policy';
import { SIGNAL_POLICY } from '../domain/signal-policy';
import type { Logger } from '../logger';
import type { ApnsClient } from '../services/apns';
import { shanghaiTrainingDay, utcDate, utcDateOnly } from '../utils/date';
import { runDailySettlement, runSessionSweep } from './activity-settlement';
import { runDailyDigest } from './daily-digest';
import { consumePushOutbox } from './push-consumer';

const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';
const SESSION_SWEEP_CRON = '*/15 * * * *';

export interface SchedulerDeps {
  db: Kysely<Database>;
  logger: Logger;
  config: Pick<Config, 'SIGNALS_CRON_ENABLED' | 'PUSH_ENABLED'>;
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

export function justClosedGymDay(now: Date): string {
  const date = utcDate(shanghaiTrainingDay(now));
  date.setUTCDate(date.getUTCDate() - 1);
  return utcDateOnly(date);
}

export function createActivityScheduler(deps: SchedulerDeps): ActivityScheduler {
  const dailyTask = cron.schedule(
    SIGNAL_POLICY.dailySettlementCron,
    async () => {
      const now = new Date();
      const gymDay = justClosedGymDay(now);
      try {
        await runDailySettlement(deps.db, gymDay, now, deps.logger, deps.config.PUSH_ENABLED);
      } catch (err) {
        deps.logger.error({ err, gymDay }, 'activity_daily_settlement_failed');
      }
    },
    { timezone: SHANGHAI_TIME_ZONE },
  );
  const sweepTask = cron.schedule(
    SESSION_SWEEP_CRON,
    async () => {
      const now = new Date();
      try {
        await runSessionSweep(deps.db, now);
      } catch (err) {
        deps.logger.error({ err }, 'activity_session_sweep_failed');
      }
    },
    { timezone: SHANGHAI_TIME_ZONE },
  );

  return {
    stop(): void {
      void dailyTask.stop();
      void sweepTask.stop();
    },
  };
}

export function startActivityScheduler(
  deps: SchedulerDeps,
  factory: SchedulerFactory = createActivityScheduler,
): ActivityScheduler | null {
  if (!deps.config.SIGNALS_CRON_ENABLED) return null;
  return factory(deps);
}

export function createPushConsumerScheduler(deps: PushSchedulerDeps): ActivityScheduler {
  const tasks: { stop(): unknown }[] = [];
  if (deps.config.PUSH_DAILY_DIGEST_ENABLED) {
    tasks.push(
      cron.schedule(
        PUSH_POLICY.dailyDigestCron,
        async () => {
          const now = new Date();
          const gymDay = justClosedGymDay(now);
          try {
            await runDailyDigest(deps.db, gymDay, now, deps.logger);
          } catch (err) {
            // Ops note: 08:00 digest assumes the 04:05 settlement finished. If a
            // settlement failure alert fired earlier, treat this run's missed
            // counts as suspect — the idempotent outbox row cannot be rewritten.
            deps.logger.error({ err, gymDay }, 'coach_daily_digest_failed');
          }
        },
        { timezone: SHANGHAI_TIME_ZONE, noOverlap: true },
      ),
    );
  }

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
        { timezone: SHANGHAI_TIME_ZONE, noOverlap: true },
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
  if (!deps.config.PUSH_ENABLED && !deps.config.PUSH_DAILY_DIGEST_ENABLED) return null;
  return factory(deps);
}
