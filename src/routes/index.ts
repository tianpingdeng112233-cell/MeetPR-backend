import type { Express, RequestHandler } from 'express';
import type { Kysely } from 'kysely';

import type { Config } from '../config';
import type { Database } from '../db/types';
import type { Logger } from '../logger';
import { authRouter } from './auth';
import { coachRouter } from './coach';
import { exercisesRouter } from './exercises';
import { coachFeedbackRouter, feedbackRouter, studentFeedbackRouter } from './feedback';
import { meRouter } from './me';
import { plansRouter, studentPlansRouter } from './plans';
import { setsRouter, studentSetsRouter } from './sets';
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
  app.use('/plans', deps.requireAuth, plansRouter({ db: deps.db, logger: deps.logger }));
  app.use('/students', deps.requireAuth, studentPlansRouter({ db: deps.db, logger: deps.logger }));
  app.use('/students', deps.requireAuth, studentSetsRouter({ db: deps.db }));
  app.use('/students', deps.requireAuth, studentFeedbackRouter({ db: deps.db }));
  app.use('/exercises', deps.requireAuth, exercisesRouter({ db: deps.db }));
  app.use('/sets', deps.requireAuth, setsRouter({ db: deps.db }));
  app.use('/feedback', deps.requireAuth, feedbackRouter({ db: deps.db }));
  app.use('/me', deps.requireAuth, meRouter());
  app.use('/coach', deps.requireAuth, coachRouter({ db: deps.db }));
  app.use('/coach', deps.requireAuth, coachFeedbackRouter({ db: deps.db }));
  app.use('/student', deps.requireAuth, studentRouter());
}
