import type { Express, RequestHandler } from 'express';
import type { Kysely } from 'kysely';

import type { Config } from '../config';
import type { Database } from '../db/types';
import type { Logger } from '../logger';
import { authRouter } from './auth';
import { coachRouter } from './coach';
import { meRouter } from './me';
import { studentRouter } from './student';

interface RouteDeps {
  config: Config;
  db: Kysely<Database>;
  logger: Logger;
  requireAuth: RequestHandler;
}

export function mountRoutes(app: Express, deps: RouteDeps): void {
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.use('/auth', authRouter({ config: deps.config, db: deps.db, logger: deps.logger }));
  app.use('/me', deps.requireAuth, meRouter());
  app.use('/coach', deps.requireAuth, coachRouter());
  app.use('/student', deps.requireAuth, studentRouter());
}
