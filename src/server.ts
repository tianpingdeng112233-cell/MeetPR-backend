import { config as loadDotenv } from 'dotenv';

if (process.env.NODE_ENV !== 'production') {
  loadDotenv();
}

import { createApp } from './app';
import { loadConfig } from './config';
import { createDb } from './db/kysely';
import { createPool } from './db/pool';
import { createLogger } from './logger';

function main(): void {
  const config = loadConfig();
  const logger = createLogger(config);
  const pool = createPool(config.DATABASE_URL, {}, config.DATABASE_SSL, config.NODE_ENV);
  const db = createDb(pool);

  const app = createApp({ config, logger, db });

  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV }, 'server_listening');
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'server_shutdown_start');
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
