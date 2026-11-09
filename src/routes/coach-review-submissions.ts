import { Router } from 'express';
import { z } from 'zod';
import { reviewerRoute, type CoachReviewDeps } from '../services/coach-reviews/auth';
import { ListedCoachInput, Id } from '../services/coach-reviews/schema';
import { isUniqueConflict } from '../services/coach-reviews/reviews';
import { validationEnvelope } from './http';
export function coachReviewSubmissionsRouter(deps: CoachReviewDeps) {
  const router = Router();
  router.post(
    '/coaches',
    reviewerRoute(deps, async (req, res, account) => {
      const input = ListedCoachInput.safeParse(req.body);
      if (!input.success) {
        res.status(400).json(validationEnvelope(input.error));
        return;
      }
      try {
        const saved = await deps.db
          .insertInto('listed_coaches')
          .values({ ...input.data, status: 'pending', submitted_by: account.id })
          .returning(['id', 'status'])
          .executeTakeFirstOrThrow();
        res.status(201).json(saved);
      } catch (error) {
        if (!isUniqueConflict(error)) throw error;
        const existing = await deps.db
          .selectFrom('listed_coaches')
          .select('id')
          .where('douyin_handle', '=', input.data.douyin_handle)
          .executeTakeFirstOrThrow();
        res.status(409).json({
          error: 'LISTED_COACH_EXISTS',
          message: '这位教练已经在列表里',
          listed_coach_id: existing.id,
          url: `/public/coach-reviews/coaches/${existing.id}`,
        });
      }
    }),
  );
  router.post(
    '/reviews/:id/reports',
    reviewerRoute(deps, async (req, res, account) => {
      const input = z
        .object({
          reason: z.enum(['abuse', 'privacy', 'advertising', 'other']),
          explanation: z.string().trim().min(1).max(1000).nullable().default(null),
        })
        .refine((v) => v.reason !== 'other' || !!v.explanation, {
          message: 'explanation_required',
          path: ['explanation'],
        })
        .safeParse(req.body);
      const id = Id.safeParse(req.params.id);
      if (!input.success) {
        res.status(400).json(validationEnvelope(input.error));
        return;
      }
      if (!id.success) {
        res.status(400).json(validationEnvelope(id.error));
        return;
      }
      try {
        const saved = await deps.db.transaction().execute(async (trx) => {
          const review = await trx
            .selectFrom('coach_reviews')
            .innerJoin('listed_coaches', 'listed_coaches.id', 'coach_reviews.listed_coach_id')
            .select('coach_reviews.id')
            .where('coach_reviews.id', '=', id.data)
            .where('coach_reviews.deleted_at', 'is', null)
            .where('listed_coaches.status', '=', 'published')
            .forUpdate()
            .executeTakeFirst();
          if (!review) return null;
          return trx
            .insertInto('coach_review_reports')
            .values({ ...input.data, review_id: id.data, account_id: account.id })
            .returning('id')
            .executeTakeFirstOrThrow();
        });
        if (!saved) {
          res.status(404).json({ error: 'COACH_REVIEW_NOT_FOUND' });
          return;
        }
        res.status(201).json(saved);
      } catch (error) {
        if (isUniqueConflict(error)) {
          res.status(409).json({ error: 'COACH_REVIEW_ALREADY_REPORTED' });
          return;
        }
        throw error;
      }
    }),
  );
  return router;
}
