import { Router } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../db/types';
import { listCoachEnquiries, updateCoachEnquiry } from '../handlers/coach-enquiries';
import { requireRole } from '../middleware/auth';
import { validationEnvelope } from './http';
import { pageRoute, pageUserId } from './coach-page-http';

export function coachEnquiriesRouter({ db }: { db: Kysely<Database> }) {
  const router = Router();
  router.get(
    '/enquiries',
    requireRole('coach'),
    pageRoute(async (req, res) => {
      res.json({ enquiries: await listCoachEnquiries(db, pageUserId(req)) });
    }),
  );
  router.patch(
    '/enquiries/:id',
    requireRole('coach'),
    pageRoute(async (req, res) => {
      const parsed = z
        .object({
          id: z.string().uuid(),
          body: z.object({ status: z.enum(['new', 'contacted', 'closed']) }).strict(),
        })
        .safeParse({ id: req.params.id, body: req.body as unknown });
      if (!parsed.success) {
        res.status(400).json(validationEnvelope(parsed.error));
        return;
      }
      res.json(
        await updateCoachEnquiry(db, pageUserId(req), parsed.data.id, parsed.data.body.status),
      );
    }),
  );
  return router;
}
