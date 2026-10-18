import path from 'node:path';
import { Router } from 'express';

/** These SPA entries share /coach with authenticated API routes. */
export function coachOnboardingPagesRouter() {
  const router = Router();
  router.get(
    ['/coach', '/coach/set-password', '/coach/welcome', '/coach/login'],
    (req, res, next) => {
      if (req.accepts(['json', 'html']) !== 'html') {
        next();
        return;
      }
      res.sendFile(path.resolve(process.cwd(), 'web/index.html'), (error: Error | undefined) => {
        if (error) next(error);
      });
    },
  );
  return router;
}
