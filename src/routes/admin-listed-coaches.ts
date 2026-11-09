import { Router } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../db/types';
import { ListedCoachInput, Id } from '../services/coach-reviews/schema';
import { isUniqueConflict } from '../services/coach-reviews/reviews';
import { route, validationEnvelope } from './http';
export function adminListedCoachesRouter(db: Kysely<Database>) {
  const router = Router();
  router.get(
    '/coaches',
    route(async (req, res) => {
      const input = z
        .object({
          q: z.string().max(200).optional(),
          status: z.enum(['pending', 'published', 'hidden', 'rejected']).optional(),
        })
        .safeParse(req.query);
      if (!input.success) {
        res.status(400).json(validationEnvelope(input.error));
        return;
      }
      let query = db.selectFrom('listed_coaches').selectAll();
      const { q, status } = input.data;
      if (q)
        query = query.where((eb) =>
          eb.or([
            eb('name', 'ilike', `%${q}%`),
            eb('nickname', 'ilike', `%${q}%`),
            eb('douyin_handle', 'ilike', `%${q}%`),
          ]),
        );
      if (status) query = query.where('status', '=', status);
      res.json({ coaches: await query.orderBy('updated_at', 'desc').execute() });
    }),
  );
  router.get(
    '/submissions',
    route(async (_req, res) => {
      res.json({
        coaches: await db
          .selectFrom('listed_coaches')
          .selectAll()
          .where('status', '=', 'pending')
          .orderBy('created_at')
          .execute(),
      });
    }),
  );
  router.patch(
    '/coaches/:id',
    route(async (req, res) => {
      const id = Id.safeParse(req.params.id),
        input = ListedCoachInput.safeParse(req.body);
      if (!id.success) {
        res.status(400).json(validationEnvelope(id.error));
        return;
      }
      if (!input.success) {
        res.status(400).json(validationEnvelope(input.error));
        return;
      }
      try {
        const saved = await db
          .updateTable('listed_coaches')
          .set({ ...input.data, updated_at: new Date(Date.now()) })
          .where('id', '=', id.data)
          .returningAll()
          .executeTakeFirst();
        if (!saved) {
          res.status(404).json({ error: 'LISTED_COACH_NOT_FOUND' });
          return;
        }
        res.json(saved);
      } catch (error) {
        if (isUniqueConflict(error)) {
          res.status(409).json({ error: 'LISTED_COACH_EXISTS' });
          return;
        }
        throw error;
      }
    }),
  );
  router.post(
    '/coaches/:id/status',
    route(async (req, res) => {
      const id = Id.safeParse(req.params.id),
        input = z.object({ status: z.enum(['published', 'hidden']) }).safeParse(req.body);
      if (!id.success) {
        res.status(400).json(validationEnvelope(id.error));
        return;
      }
      if (!input.success) {
        res.status(400).json(validationEnvelope(input.error));
        return;
      }
      const saved = await db
        .updateTable('listed_coaches')
        .set({ status: input.data.status, updated_at: new Date(Date.now()) })
        .where('id', '=', id.data)
        .where('status', '=', input.data.status === 'hidden' ? 'published' : 'hidden')
        .returningAll()
        .executeTakeFirst();
      if (!saved) {
        res.status(409).json({ error: 'LISTED_COACH_INVALID_STATE' });
        return;
      }
      res.json(saved);
    }),
  );
  router.post(
    '/submissions/:id/decision',
    route(async (req, res) => {
      const id = Id.safeParse(req.params.id),
        input = z
          .object({
            action: z.enum(['approve', 'reject']),
            reason: z.string().trim().max(1000).optional(),
          })
          .safeParse(req.body);
      if (!id.success) {
        res.status(400).json(validationEnvelope(id.error));
        return;
      }
      if (!input.success) {
        res.status(400).json(validationEnvelope(input.error));
        return;
      }
      const saved = await db
        .updateTable('listed_coaches')
        .set({
          status: input.data.action === 'approve' ? 'published' : 'rejected',
          rejection_reason: input.data.action === 'reject' ? (input.data.reason ?? null) : null,
          reviewed_by: req.user?.id ?? null,
          reviewed_at: new Date(Date.now()),
          updated_at: new Date(Date.now()),
        })
        .where('id', '=', id.data)
        .where('status', '=', 'pending')
        .returningAll()
        .executeTakeFirst();
      if (!saved) {
        res.status(409).json({ error: 'LISTED_COACH_INVALID_STATE' });
        return;
      }
      res.json(saved);
    }),
  );
  return router;
}
