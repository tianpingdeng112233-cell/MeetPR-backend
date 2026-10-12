import type { Config } from '../config';
import { Router } from 'express';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types';
import { editCoachPage, pagePreview, transitionPage } from '../handlers/coach-pages';
import { requireRole } from '../middleware/auth';
import { validationEnvelope } from './http';
import { pageEditSchema, pageRoute, pageUserId } from './coach-page-http';

export function coachPageRouter({ db, config }: { db: Kysely<Database>; config: Config }) {
  const router = Router();
  router.get(
    '/page',
    requireRole('coach'),
    pageRoute(async (req, res) => {
      res.json(await pagePreview(db, pageUserId(req), config));
    }),
  );
  router.put(
    '/page',
    requireRole('coach'),
    pageRoute(async (req, res) => {
      const parsed = pageEditSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json(validationEnvelope(parsed.error));
        return;
      }
      await editCoachPage(db, pageUserId(req), parsed.data);
      res.json(await pagePreview(db, pageUserId(req), config));
    }),
  );
  for (const action of ['submit', 'hide', 'show'] as const) {
    router.post(
      `/page/${action}`,
      requireRole('coach'),
      pageRoute(async (req, res) => {
        await transitionPage(db, pageUserId(req), action);
        res.json(await pagePreview(db, pageUserId(req), config));
      }),
    );
  }
  return router;
}
