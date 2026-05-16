import { Router } from 'express';
import type { Kysely } from 'kysely';

import type { Database } from '../db/types';
import { listCoachStudents } from '../handlers/coach-students';
import { requireRole } from '../middleware/auth';
import { notImplemented } from '../utils/notImplemented';
import { route } from './http';

interface CoachRouterDeps {
  db: Kysely<Database>;
}

export function coachRouter(deps: CoachRouterDeps): Router {
  const router = Router();

  router.get('/dashboard', (_req, res) => {
    notImplemented(res, 'GET /coach/dashboard');
  });

  router.get(
    '/students',
    requireRole('coach'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const students = await listCoachStudents(deps.db, req.user.id);
      res.status(200).json({ students });
    }),
  );

  return router;
}
