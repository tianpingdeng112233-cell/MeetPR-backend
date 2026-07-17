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
import { consumePushOutbox } from './push-consumer';

const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';
const SESSION_SWEEP_CRON = '*/15 * * * *';

export interface SchedulerDeps {
  db: Kysely<Database>;
  logger: Logger;
  config: Pick<Config, 'SIGNALS_CRON_ENABLED'>;
}

export interface ActivityScheduler {
  stop(): void;
}

export type SchedulerFactory = (deps: SchedulerDeps) => ActivityScheduler;

export interface PushSchedulerDeps {
  db: Kysely<Database>;
  logger: Logger;
  config: Pick<Config, 'PUSH_ENABLED'>;
  apnsClient: ApnsClient;
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
        await runDailySettlement(deps.db, gymDay, now, deps.logger);
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
  const consumerTask = cron.schedule(
    PUSH_POLICY.consumerCron,
    async () => {
      const now = new Date();
      try {
        await consumePushOutbox(deps.db, deps.apnsClient, now, deps.logger);
      } catch (err) {
        deps.logger.error({ err }, 'push_outbox_consumer_failed');
      }
    },
    // noOverlap: a slow APNs batch must skip the next tick instead of stacking
    // concurrent consumers on the same rows.
    { timezone: SHANGHAI_TIME_ZONE, noOverlap: true },
  );

  return {
    stop(): void {
      void consumerTask.stop();
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
