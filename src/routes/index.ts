import type { Express, RequestHandler } from 'express';
import type { Kysely } from 'kysely';

import type { Config } from '../config';
import type { Database } from '../db/types';
import type { Logger } from '../logger';
import { authRouter } from './auth';
import { coachBindRequestsRouter, studentBindRequestsRouter } from './bind-requests';
import { coachRouter } from './coach';
import { coachEvaluationsRouter, studentEvaluationsRouter } from './evaluations';
import { exercisesRouter } from './exercises';
import { coachFeedbackRouter, feedbackRouter, studentFeedbackRouter } from './feedback';
import { coachInviteCodesRouter } from './invite-codes';
import { meRouter } from './me';
import { coachOneRmRouter, studentOnboardingRouter } from './onboarding';
import { studentVideosRouter } from './videos';
import { plansRouter, studentPlansRouter } from './plans';
import { studentReadinessRouter } from './readiness';
import { studentReviewsRouter } from './reviews';
import { setsRouter, studentSetsRouter } from './sets';
import { studentRouter } from './student';
import { uploadsRouter } from './uploads';
import type { OssService } from '../services/oss';

interface RouteDeps {
  config: Config;
  db: Kysely<Database>;
  logger: Logger;
  oss?: OssService | undefined;
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
  app.use('/students', deps.requireAuth, studentReadinessRouter({ db: deps.db }));
  app.use('/students', deps.requireAuth, studentReviewsRouter({ db: deps.db }));
  app.use('/students', deps.requireAuth, studentFeedbackRouter({ db: deps.db }));
  app.use('/students', deps.requireAuth, studentEvaluationsRouter({ db: deps.db }));
  app.use('/students', deps.requireAuth, studentOnboardingRouter({ db: deps.db }));
  app.use('/students', deps.requireAuth, studentVideosRouter({ db: deps.db }));
  app.use('/bind-requests', deps.requireAuth, studentBindRequestsRouter({ db: deps.db }));
  app.use('/exercises', deps.requireAuth, exercisesRouter({ db: deps.db }));
  app.use('/sets', deps.requireAuth, setsRouter({ db: deps.db }));
  app.use('/feedback', deps.requireAuth, feedbackRouter({ db: deps.db }));
  app.use('/me', deps.requireAuth, meRouter({ db: deps.db, logger: deps.logger }));
  app.use('/coach', deps.requireAuth, coachRouter({ db: deps.db }));
  app.use('/coach', deps.requireAuth, coachFeedbackRouter({ db: deps.db }));
  app.use('/coach', deps.requireAuth, coachInviteCodesRouter({ db: deps.db }));
  app.use('/coach', deps.requireAuth, coachBindRequestsRouter({ db: deps.db }));
  app.use('/coach', deps.requireAuth, coachEvaluationsRouter({ db: deps.db }));
  app.use('/coach', deps.requireAuth, coachOneRmRouter({ db: deps.db }));
  app.use('/student', deps.requireAuth, studentRouter());
  app.use(
    '/uploads',
    deps.requireAuth,
    uploadsRouter({ db: deps.db, logger: deps.logger, oss: deps.oss }),
  );
}
