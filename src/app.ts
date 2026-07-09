import path from 'node:path';

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
      // HSTS is only emitted once FORCE_HTTPS is on (the HTTPS go-live switch),
      // so localhost and HTTP test clients — and a pre-TLS production build —
      // remain usable.
      ...(config.FORCE_HTTPS ? {} : { strictTransportSecurity: false }),
    }),
  );
  app.use(
    cors({
      origin:
        config.CORS_ORIGIN === '*' ? true : config.CORS_ORIGIN.split(',').map((s) => s.trim()),
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  if (config.FORCE_HTTPS) {
    app.use((req, res, next) => {
      // TLS terminates at the trusted reverse proxy. /health is kept available
      // for the load balancer's internal HTTP health check; it exposes no user
      // data or credentials. Every public API route fails closed otherwise.
      // Gated on FORCE_HTTPS so this only activates at HTTPS go-live.
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

  // Serve the bundled plan-web frontend (self-hosted, same-origin) when present.
  // API routes above win; static assets next; a browser navigation to a client-side
  // route falls back to the SPA. Content-negotiated so this shared API+SPA origin does
  // not turn unmatched API GETs into HTML: only requests that explicitly prefer HTML
  // (real browser navigations) get the SPA; API clients (Accept: application/json, or
  // */* which resolves to the first listed type) fall through to notFound's JSON 404 —
  // this backend also serves the iOS app, whose error handling expects JSON.
  // web/ is absent in dev (no build) — sendFile errors then fall through to notFound.
  const webDir = path.resolve(process.cwd(), 'web');
  app.use(express.static(webDir));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.accepts(['json', 'html']) !== 'html') {
      next();
      return;
    }
    // err is Error | undefined at runtime (undefined on success) despite express's
    // non-optional Errback type; annotate so the truthiness check is honest.
    res.sendFile(path.join(webDir, 'index.html'), (err: Error | undefined) => {
      if (err) next();
    });
  });

  app.use(notFound);
  app.use(createErrorHandler(logger));

  return app;
}
