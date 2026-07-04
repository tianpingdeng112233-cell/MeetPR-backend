import { Router, type Router as ExpressRouter } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import { hasAcceptedBond } from '../db/bonds';
import type { Database } from '../db/types';
import { fetchSessionReviews, upsertSessionReview } from '../handlers/reviews';
import { requireRole } from '../middleware/auth';
import { uuidEquals } from '../utils/uuid';
import { route, validationEnvelope } from './http';

interface ReviewsRouterDeps {
  db: Kysely<Database>;
}

const UuidSchema = z.string().uuid();
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');
const RpeSchema = z
  .union([z.string(), z.number()])
  .transform((value) => (typeof value === 'number' ? String(value) : value))
  .pipe(z.string().regex(/^\d+(\.\d)?$/, 'RPE must have at most 1 decimal'))
  .refine((value) => Number(value) >= 0 && Number(value) <= 10, 'RPE must be between 0 and 10');

const ReviewBodySchema = z
  .object({
    feeling: z.string(),
    session_rpe: RpeSchema.nullable().optional(),
  })
  .strict()
  .transform((body) => ({
    feeling: body.feeling.trim(),
    session_rpe: body.session_rpe == null ? null : Number(body.session_rpe).toFixed(1),
  }));

const ReviewDateParamSchema = z.object({ date: DateSchema });
const StudentIdParamSchema = z.object({ id: UuidSchema });
const ReviewQuerySchema = z
  .object({
    from: DateSchema,
    to: DateSchema,
  })
  .strict()
  .refine((query) => query.to >= query.from, {
    path: ['to'],
    message: 'to must be on or after from',
  });

/// 学员写自己的当日回顾 + 本人/已绑定教练读取 (spec 012)。Mounted at
/// /students, same idiom as readiness: PUT /students/me/reviews/:date.
export function studentReviewsRouter(deps: ReviewsRouterDeps): ExpressRouter {
  const router = Router();

  router.put(
    '/me/reviews/:date',
    requireRole('coached_student', 'self_train_student'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }
      const params = ReviewDateParamSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }
      const body = ReviewBodySchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }
      if (body.data.feeling.length === 0) {
        res.status(400).json({ error: 'REVIEWS_FEELING_REQUIRED' });
        return;
      }

      const review = await upsertSessionReview(deps.db, req.user.id, {
        review_date: params.data.date,
        feeling: body.data.feeling,
        session_rpe: body.data.session_rpe,
      });
      res.status(200).json(review);
    }),
  );

  router.get(
    '/:id/reviews',
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }
      const params = StudentIdParamSchema.safeParse(req.params);
      const query = ReviewQuerySchema.safeParse(req.query);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }
      if (!query.success) {
        res.status(400).json(validationEnvelope(query.error));
        return;
      }

      const isSelf = uuidEquals(req.user.id, params.data.id);
      if (!isSelf) {
        const bonded =
          req.user.role === 'coach' &&
          (await hasAcceptedBond(deps.db, req.user.id, params.data.id));
        if (!bonded) {
          res.status(403).json({ error: 'AUTHORIZATION_FORBIDDEN' });
          return;
        }
      }

      const reviews = await fetchSessionReviews(
        deps.db,
        params.data.id,
        query.data.from,
        query.data.to,
      );
      res.status(200).json({ reviews });
    }),
  );

  return router;
}
