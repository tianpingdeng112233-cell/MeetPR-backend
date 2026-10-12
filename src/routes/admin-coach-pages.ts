import type { Config } from '../config';
import { Router } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../db/types';
import {
  editCoachPage,
  pagePreview,
  requireCoach,
  setSubscription,
  transitionPage,
} from '../handlers/coach-pages';
import { pageRoute, slugSchema } from './coach-page-http';
import { validationEnvelope } from './http';

// Mounted inside adminRouter, after BOTH the token role gate and live DB role check.
export function adminCoachPagesRouter({ db, config }: { db: Kysely<Database>; config: Config }) {
  const router = Router();
  router.param('coachId', (req, res, next, value: string) => {
    const parsed = z.string().uuid().safeParse(value);
    if (!parsed.success) {
      res.status(400).json(validationEnvelope(parsed.error));
      return;
    }
    next();
  });
  router.get(
    '/coach-pages',
    pageRoute(async (_req, res) => {
      const coaches = await db
        .selectFrom('users')
        .select('id')
        .where('role', '=', 'coach')
        .orderBy('created_at')
        .execute();
      res.json({
        pages: await Promise.all(coaches.map((c) => pagePreview(db, c.id, config, true))),
      });
    }),
  );
  for (const action of ['approve', 'reject', 'suspend', 'restore', 'mark-reviewed'] as const) {
    router.post(
      `/coach-pages/:coachId/${action}`,
      pageRoute(async (req, res) => {
        const coachId = req.params.coachId ?? '';
        await requireCoach(db, coachId);
        let reason: string | undefined;
        if (action === 'reject') {
          const parsed = z
            .object({ reason: z.string().trim().min(1).max(500) })
            .strict()
            .safeParse(req.body);
          if (!parsed.success) {
            res.status(400).json(validationEnvelope(parsed.error));
            return;
          }
          reason = parsed.data.reason;
        }
        await transitionPage(db, coachId, action, reason);
        res.json(await pagePreview(db, coachId, config, true));
      }),
    );
  }
  router.put(
    '/coach-pages/:coachId/slug',
    pageRoute(async (req, res) => {
      const parsed = z.object({ slug: slugSchema }).strict().safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json(validationEnvelope(parsed.error));
        return;
      }
      await requireCoach(db, req.params.coachId ?? '');
      await editCoachPage(db, req.params.coachId ?? '', parsed.data, true);
      res.json(await pagePreview(db, req.params.coachId ?? '', config, true));
    }),
  );
  router.put(
    '/coaches/:coachId/subscription',
    pageRoute(async (req, res) => {
      const parsed = z
        .object({ expires_at: z.string().datetime({ offset: true }).nullable() })
        .strict()
        .safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json(validationEnvelope(parsed.error));
        return;
      }
      await setSubscription(
        db,
        req.params.coachId ?? '',
        parsed.data.expires_at ? new Date(parsed.data.expires_at) : null,
      );
      res.json({ expires_at: parsed.data.expires_at });
    }),
  );
  return router;
}
