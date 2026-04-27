import { Router } from 'express';

import { notImplemented } from '../utils/notImplemented';

export function coachRouter(): Router {
  const router = Router();

  router.get('/dashboard', (_req, res) => {
    notImplemented(res, 'GET /coach/dashboard');
  });

  router.get('/students', (_req, res) => {
    notImplemented(res, 'GET /coach/students');
  });

  router.post('/plans', (_req, res) => {
    notImplemented(res, 'POST /coach/plans');
  });

  return router;
}
