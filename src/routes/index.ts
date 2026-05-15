import type { Express, RequestHandler } from 'express';
import type { Kysely } from 'kysely';

import type { Config } from '../config';
import type { Database } from '../db/types';
import type { Logger } from '../logger';
import { authRouter } from './auth';
import { coachRouter } from './coach';
import { exercisesRouter } from './exercises';
import { meRouter } from './me';
import { plansRouter, studentPlansRouter } from './plans';
import { privacyRouter } from './privacy';
import { studentRouter } from './student';
import { uploadRouter } from './upload';
import { videosRouter } from './videos';
import type { OSSClient } from '../oss/client';

interface RouteDeps {
  config: Config;
  db: Kysely<Database>;
  logger: Logger;
  oss: OSSClient;
  requireAuth: RequestHandler;
}

export function mountRoutes(app: Express, deps: RouteDeps): void {
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.use('/auth', authRouter({ config: deps.config, db: deps.db, logger: deps.logger }));
  app.use('/plans', deps.requireAuth, plansRouter({ db: deps.db, logger: deps.logger }));
  app.use('/upload', deps.requireAuth, uploadRouter({ db: deps.db, oss: deps.oss }));
  app.use('/privacy', deps.requireAuth, privacyRouter({ db: deps.db }));
  app.use('/students', deps.requireAuth, videosRouter({ db: deps.db, oss: deps.oss }));
  app.use('/students', deps.requireAuth, studentPlansRouter({ db: deps.db, logger: deps.logger }));
  app.use('/exercises', deps.requireAuth, exercisesRouter({ db: deps.db }));
  app.use('/me', deps.requireAuth, meRouter());
  app.use('/coach', deps.requireAuth, coachRouter());
  app.use('/student', deps.requireAuth, studentRouter());
}
