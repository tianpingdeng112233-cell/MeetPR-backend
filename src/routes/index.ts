import type { Express, RequestHandler } from 'express';

import { authRouter } from './auth';
import { coachRouter } from './coach';
import { meRouter } from './me';
import { studentRouter } from './student';

interface RouteDeps {
  requireAuth: RequestHandler;
}

export function mountRoutes(app: Express, deps: RouteDeps): void {
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.use('/auth', authRouter());
  app.use('/me', deps.requireAuth, meRouter());
  app.use('/coach', deps.requireAuth, coachRouter());
  app.use('/student', deps.requireAuth, studentRouter());
}
