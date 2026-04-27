import { Router } from 'express';

import { notImplemented } from '../utils/notImplemented';

export function studentRouter(): Router {
  const router = Router();

  router.get('/plan', (_req, res) => {
    notImplemented(res, 'GET /student/plan');
  });

  router.post('/sets', (_req, res) => {
    notImplemented(res, 'POST /student/sets');
  });

  return router;
}
