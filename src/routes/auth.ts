import { Router } from 'express';

import { notImplemented } from '../utils/notImplemented';

export function authRouter(): Router {
  const router = Router();

  router.post('/register', (_req, res) => {
    notImplemented(res, 'POST /auth/register');
  });

  router.post('/login', (_req, res) => {
    notImplemented(res, 'POST /auth/login');
  });

  router.post('/refresh', (_req, res) => {
    notImplemented(res, 'POST /auth/refresh');
  });

  return router;
}
