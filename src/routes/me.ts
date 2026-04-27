import { Router } from 'express';

import { notImplemented } from '../utils/notImplemented';

export function meRouter(): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    notImplemented(res, 'GET /me');
  });

  return router;
}
