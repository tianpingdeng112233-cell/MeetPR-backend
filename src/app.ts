import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Kysely } from 'kysely';
import pinoHttp from 'pino-http';

import type { Config } from './config';
import type { Database } from './db/types';
import type { Logger } from './logger';
import { createRequireAuth } from './middleware/auth';
import { createErrorHandler } from './middleware/errorHandler';
import { notFound } from './middleware/notFound';
import { createGlobalRateLimit } from './middleware/rateLimit';
import { requestId } from './middleware/requestId';
import { mountRoutes } from './routes';

export interface AppDeps {
  config: Config;
  logger: Logger;
  db: Kysely<Database>;
}

export function createApp(deps: AppDeps): Express {
  const { config, logger } = deps;
  const app = express();

  app.set('trust proxy', config.TRUST_PROXY);

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(
    cors({
      origin:
        config.CORS_ORIGIN === '*' ? true : config.CORS_ORIGIN.split(',').map((s) => s.trim()),
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(requestId);
  app.use(pinoHttp({ logger }));
  app.use(createGlobalRateLimit(config));

  mountRoutes(app, {
    requireAuth: createRequireAuth(config),
  });

  app.use(notFound);
  app.use(createErrorHandler(logger));

  return app;
}
