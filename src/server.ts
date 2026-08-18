import { config as loadDotenv } from 'dotenv';

if (process.env.NODE_ENV !== 'production') {
  loadDotenv();
}

import { createApp } from './app';
import { loadConfig } from './config';
import { createDb } from './db/kysely';
import { createPool } from './db/pool';
import { createLogger } from './logger';
import { createRealtimeHub } from './realtime/hub';
import { attachRealtimeUpgrade } from './realtime/upgrade';
import { startActivityScheduler, startPushConsumerScheduler } from './jobs/scheduler';
import { createApnsClient } from './services/apns';
import { selectStorageService } from './services/storage-selector';

function main(): void {
  const config = loadConfig();
  const logger = createLogger(config);
  const pool = createPool(config.DATABASE_URL);
  const db = createDb(pool);
  const oss = selectStorageService(config);
  if (!oss) {
    logger.warn(
      {},
      config.STORAGE_BACKEND === 's3'
        ? 's3_not_configured_uploads_disabled'
        : 'oss_not_configured_uploads_disabled',
    );
  }
  const hub = createRealtimeHub({ logger });

  const app = createApp({ config, logger, db, oss, hub });

  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV }, 'server_listening');
  });
  const wss = attachRealtimeUpgrade({ server, hub, config, logger });
  const scheduler = startActivityScheduler({ config, logger, db });
  const pushScheduler = startPushConsumerScheduler({
    config,
    logger,
    db,
    ...(config.PUSH_ENABLED ? { apnsClient: createApnsClient(config) } : {}),
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'server_shutdown_start');
    scheduler?.stop();
    pushScheduler?.stop();
    wss.close();
    for (const socket of wss.clients) {
      socket.terminate();
    }
    server.close((closeErr) => {
      if (closeErr) {
        logger.error({ err: closeErr }, 'server_close_error');
      }
      pool
        .end()
        .then(() => {
          logger.info({}, 'server_shutdown_complete');
          process.exit(closeErr ? 1 : 0);
        })
        .catch((poolErr: unknown) => {
          logger.error({ err: poolErr }, 'pool_close_error');
          process.exit(1);
        });
    });
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}

try {
  main();
} catch (err) {
  console.error('fatal_startup_error', err);
  process.exit(1);
}
