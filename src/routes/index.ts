import type { Express, RequestHandler } from 'express';
import type { Kysely } from 'kysely';

import type { Config } from '../config';
import type { Database } from '../db/types';
import type { Logger } from '../logger';
import { createOptionalAuth } from '../middleware/auth';
import { adminRouter } from './admin';
import { authRouter } from './auth';
import { coachBindRequestsRouter, studentBindRequestsRouter } from './bind-requests';
import { coachRouter } from './coach';
import { conversationsRouter } from './conversations';
import { devicesRouter } from './devices';
import { eventsRouter } from './events';
import { coachEvaluationsRouter, studentEvaluationsRouter } from './evaluations';
import { exercisesRouter } from './exercises';
import { coachExerciseStatsRouter } from './exercise-stats';
import { coachFeedbackRouter, feedbackRouter, studentFeedbackRouter } from './feedback';
import { coachInviteCodesRouter } from './invite-codes';
import { meRouter } from './me';
import { coachOneRmRouter, studentOnboardingRouter } from './onboarding';
import { studentVideosRouter } from './videos';
import { plansRouter, studentPlansRouter } from './plans';
import { studentReadinessRouter } from './readiness';
import { studentReviewsRouter } from './reviews';
import { setsRouter, studentSetsRouter } from './sets';
import { coachSignalsRouter, studentSignalsRouter } from './signals';
import { studentRouter } from './student';
import { studentTrainingStreakRouter } from './training-streak';
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
  app.use('/admin', deps.requireAuth, adminRouter({ db: deps.db }));
  app.use('/plans', deps.requireAuth, plansRouter({ db: deps.db, logger: deps.logger }));
  app.use('/students', deps.requireAuth, studentPlansRouter({ db: deps.db, logger: deps.logger }));
  app.use('/students', deps.requireAuth, studentSetsRouter({ db: deps.db }));
  app.use('/students', deps.requireAuth, studentReadinessRouter({ db: deps.db }));
  app.use('/students', deps.requireAuth, studentReviewsRouter({ db: deps.db }));
  app.use('/students', deps.requireAuth, studentFeedbackRouter({ db: deps.db }));
  app.use('/students', deps.requireAuth, studentEvaluationsRouter({ db: deps.db }));
  app.use('/students', deps.requireAuth, studentOnboardingRouter({ db: deps.db }));
  app.use('/students', deps.requireAuth, studentVideosRouter({ db: deps.db }));
  app.use('/students', deps.requireAuth, studentSignalsRouter({ db: deps.db }));
  app.use('/students', deps.requireAuth, studentTrainingStreakRouter({ db: deps.db }));
  app.use('/bind-requests', deps.requireAuth, studentBindRequestsRouter({ db: deps.db }));
  app.use('/exercises', deps.requireAuth, exercisesRouter({ db: deps.db }));
  app.use('/sets', deps.requireAuth, setsRouter({ db: deps.db }));
  app.use('/feedback', deps.requireAuth, feedbackRouter({ db: deps.db }));
  app.use('/me', deps.requireAuth, meRouter({ db: deps.db, logger: deps.logger }));
  app.use('/devices', deps.requireAuth, devicesRouter({ db: deps.db }));
  app.use(
    '/conversations',
    deps.requireAuth,
    conversationsRouter({ db: deps.db, logger: deps.logger, oss: deps.oss }),
  );
  app.use('/coach', deps.requireAuth, coachRouter({ db: deps.db, logger: deps.logger }));
  app.use('/coach', deps.requireAuth, coachExerciseStatsRouter({ db: deps.db }));
  app.use('/coach', deps.requireAuth, coachFeedbackRouter({ db: deps.db }));
  app.use('/coach', deps.requireAuth, coachInviteCodesRouter({ db: deps.db }));
  app.use('/coach', deps.requireAuth, coachBindRequestsRouter({ db: deps.db }));
  app.use('/coach', deps.requireAuth, coachEvaluationsRouter({ db: deps.db }));
  app.use('/coach', deps.requireAuth, coachOneRmRouter({ db: deps.db }));
  app.use('/coach', deps.requireAuth, coachSignalsRouter({ db: deps.db, logger: deps.logger }));
  app.use('/student', deps.requireAuth, studentRouter());
  // Analytics ingest (SPEC 008). optional-auth (NOT requireAuth): pre-login
  // onboarding events must not 401. The whole /events surface is exempt from the
  // global per-IP limiter and carries its own anon_id-keyed fail-open limiter.
  app.use(
    '/events',
    createOptionalAuth(deps.config),
    eventsRouter({ db: deps.db, logger: deps.logger, config: deps.config }),
  );
  app.use(
    '/uploads',
    deps.requireAuth,
    uploadsRouter({ db: deps.db, logger: deps.logger, oss: deps.oss }),
  );
}
