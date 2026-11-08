import { Router } from 'express';
import { z } from 'zod';

import type { Config } from '../config';

const PlatformSchema = z.enum(['ios', 'android']);

export function appMinVersionRouter(config: Config): Router {
  const router = Router();
  router.get('/min-version', (req, res) => {
    const platform = PlatformSchema.safeParse(req.query.platform);
    if (!platform.success) {
      res.status(400).json({ error: 'INVALID_PLATFORM' });
      return;
    }
    const minBuild =
      platform.data === 'ios' ? config.MIN_IOS_BUILD : config.MIN_ANDROID_VERSION_CODE;
    res.set('Cache-Control', 'max-age=300').json({ min_build: minBuild ?? 0 });
  });
  return router;
}
