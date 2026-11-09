import { adminListedCoachesRouter } from './admin-listed-coaches';
import { adminCoachReviewReportsRouter } from './admin-coach-review-reports';
import { Router } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../db/types';
import { importListedCoaches } from '../services/coach-reviews/import';
import { route, validationEnvelope } from './http';
export function adminCoachReviewsRouter(db: Kysely<Database>) {
  const router = Router();
  router.post(
    '/import',
    route(async (req, res) => {
      const input = z.object({ csv: z.string().min(1).max(900_000) }).safeParse(req.body);
      if (!input.success) {
        res.status(400).json(validationEnvelope(input.error));
        return;
      }
      try {
        res.json(await importListedCoaches(db, input.data.csv));
      } catch (error) {
        if (
          error instanceof Error &&
          ['INVALID_CSV', 'INVALID_CSV_HEADERS'].includes(error.message)
        ) {
          res.status(400).json({ error: error.message });
          return;
        }
        throw error;
      }
    }),
  );
  router.get(
    '/words',
    route(async (_req, res) => {
      res.json({
        words: await db.selectFrom('coach_review_words').selectAll().orderBy('word').execute(),
      });
    }),
  );
  router.post(
    '/words',
    route(async (req, res) => {
      const input = z.object({ word: z.string().trim().min(1).max(100) }).safeParse(req.body);
      if (!input.success) {
        res.status(400).json(validationEnvelope(input.error));
        return;
      }
      const word = await db
        .insertInto('coach_review_words')
        .values(input.data)
        .onConflict((oc) => oc.column('word').doUpdateSet(input.data))
        .returningAll()
        .executeTakeFirstOrThrow();
      res.status(201).json(word);
    }),
  );
  router.delete(
    '/words/:id',
    route(async (req, res) => {
      const id = z.string().uuid().safeParse(req.params.id);
      if (!id.success) {
        res.status(400).json(validationEnvelope(id.error));
        return;
      }
      await db.deleteFrom('coach_review_words').where('id', '=', id.data).execute();
      res.status(204).end();
    }),
  );
  router.use(adminListedCoachesRouter(db));
  router.use(adminCoachReviewReportsRouter(db));
  return router;
}
