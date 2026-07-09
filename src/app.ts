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
import type { OssService } from './services/oss';

export interface AppDeps {
  config: Config;
  logger: Logger;
  db: Kysely<Database>;
  /** Absent when OSS env vars are not configured — /uploads/* answers 503. */
  oss?: OssService | undefined;
}

export function createApp(deps: AppDeps): Express {
  const { config, logger } = deps;
  const app = express();

  app.set('trust proxy', config.TRUST_PROXY);

  app.use(
    helmet({
      contentSecurityPolicy: false,
      // Public production traffic is HTTPS-only. HSTS is intentionally only
      // emitted there so localhost and HTTP test clients remain usable.
      ...(config.NODE_ENV === 'production' ? {} : { strictTransportSecurity: false }),
    }),
  );
  app.use(
    cors({
      origin:
        config.CORS_ORIGIN === '*' ? true : config.CORS_ORIGIN.split(',').map((s) => s.trim()),
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  if (config.NODE_ENV === 'production') {
    app.use((req, res, next) => {
      // TLS terminates at the trusted reverse proxy. /health is kept available
      // for the load balancer's internal HTTP health check; it exposes no user
      // data or credentials. Every public API route fails closed otherwise.
      if (req.path === '/health' || req.secure) {
        next();
        return;
      }
      res.status(426).json({ error: 'HTTPS_REQUIRED' });
    });
  }
  app.use(requestId);
  app.use(pinoHttp({ logger }));
  app.use(createGlobalRateLimit(config));

  mountRoutes(app, {
    config,
    db: deps.db,
    logger,
    oss: deps.oss,
    requireAuth: createRequireAuth(config),
  });

  app.use(notFound);
  app.use(createErrorHandler(logger));

  return app;
}
