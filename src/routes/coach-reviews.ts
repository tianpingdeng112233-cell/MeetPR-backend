import { coachReviewSubmissionsRouter } from './coach-review-submissions';
import { sql } from 'kysely';
import {
  listedCoachQuery,
  publicCoach,
  publicReviews,
  publicCoachStats,
} from '../services/coach-reviews/browse';
import { Id, textByCharacters } from '../services/coach-reviews/schema';
import {
  CoachReviewInput,
  rejectBlockedReview,
  isUniqueConflict,
} from '../services/coach-reviews/reviews';
import { Router } from 'express';
import { z } from 'zod';
import { createGlobalRateLimit } from '../middleware/rateLimit';
import {
  Phone,
  requestCoachReviewOtp,
  loginCoachReviewer,
  reviewerRoute,
  type CoachReviewDeps,
} from '../services/coach-reviews/auth';
import { route, validationEnvelope } from './http';
export function coachReviewsRouter(deps: CoachReviewDeps) {
  const router = Router();
  router.get('/config', (_req, res) => {
    res.json({ contact: deps.config.COACH_REVIEWS_CONTACT ?? '' });
  });
  router.get(
    '/stats',
    route(async (_req, res) => {
      res.json(await publicCoachStats(deps.db));
    }),
  );
  router.get(
    '/coaches',
    route(async (req, res) => {
      const input = z
        .object({
          province: z.string().max(200).optional(),
          city: z.string().max(200).optional(),
          teaching_mode: z.enum(['线下', '线上', '线上+线下']).optional(),
          q: z.string().max(200).optional(),
          sort: z.enum(['most', 'top', 'latest']).default('most'),
          limit: z.coerce.number().int().min(1).max(100).default(50),
          offset: z.coerce.number().int().nonnegative().default(0),
        })
        .safeParse(req.query);
      if (!input.success) {
        res.status(400).json(validationEnvelope(input.error));
        return;
      }
      const { province, city, teaching_mode, q, sort, limit, offset } = input.data;
      let query = listedCoachQuery(deps.db);
      if (province) query = query.where('province', '=', province);
      if (city) query = query.where('city', '=', city);
      if (teaching_mode) query = query.where('teaching_mode', '=', teaching_mode);
      if (q)
        query = query.where((eb) =>
          eb.or([eb('name', 'ilike', `%${q}%`), eb('nickname', 'ilike', `%${q}%`)]),
        );
      if (sort === 'top') {
        query = query
          .where('stats.review_count', '>=', 3)
          .orderBy('stats.overall', 'desc')
          .orderBy('stats.review_count', 'desc');
      } else if (sort === 'latest') {
        query = query
          .orderBy(sql`stats.latest_review_at desc nulls last`)
          .orderBy('listed_coaches.created_at', 'desc');
      } else {
        query = query
          .orderBy(sql`coalesce(stats.review_count,0)`, 'desc')
          .orderBy(sql`stats.latest_review_at desc nulls last`)
          .orderBy('name');
      }
      const count = await query
        .clearSelect()
        .clearOrderBy()
        .select((eb) => eb.fn.countAll<number | string>().as('total'))
        .executeTakeFirstOrThrow();
      const coaches = await query
        .orderBy('listed_coaches.id')
        .limit(limit)
        .offset(offset)
        .execute();
      res.json({
        coaches: coaches.map(publicCoach),
        total: Number(count.total),
        contact: deps.config.COACH_REVIEWS_CONTACT ?? '',
      });
    }),
  );
  router.get(
    '/coaches/:id',
    route(async (req, res) => {
      const id = Id.safeParse(req.params.id);
      if (!id.success) {
        res.status(400).json(validationEnvelope(id.error));
        return;
      }
      const coach = await listedCoachQuery(deps.db)
        .where('listed_coaches.id', '=', id.data)
        .executeTakeFirst();
      if (!coach) {
        res.status(404).json({
          error: 'LISTED_COACH_NOT_FOUND',
          message: '该教练页面不存在或已下架',
          contact: deps.config.COACH_REVIEWS_CONTACT ?? '',
        });
        return;
      }
      const reviews = await publicReviews(deps.db)
        .where('coach_reviews.listed_coach_id', '=', id.data)
        .execute();
      res.json({
        coach: publicCoach(coach),
        reviews,
        contact: deps.config.COACH_REVIEWS_CONTACT ?? '',
      });
    }),
  );
  const authLimit = createGlobalRateLimit({ RATE_LIMIT_WINDOW_MS: 60_000, RATE_LIMIT_MAX: 20 });
  router.post(
    '/auth/otp',
    authLimit,
    route(async (req, res) => {
      const input = z.object({ phone: Phone }).safeParse(req.body);
      if (!input.success) {
        res.status(400).json(validationEnvelope(input.error));
        return;
      }
      const reason = await requestCoachReviewOtp(deps, input.data.phone);
      if (reason) {
        res.status(429).json({ error: reason });
        return;
      }
      res.status(204).end();
    }),
  );
  router.post(
    '/auth/login',
    authLimit,
    route(async (req, res) => {
      const input = z
        .object({ phone: Phone, code: z.string().regex(/^\d{6}$/u) })
        .safeParse(req.body);
      if (!input.success) {
        res.status(400).json(validationEnvelope(input.error));
        return;
      }
      const result = await loginCoachReviewer(deps, input.data.phone, input.data.code);
      if (!result) {
        res.status(401).json({ error: 'OTP_INVALID' });
        return;
      }
      res.set('Cache-Control', 'no-store').json(result);
    }),
  );
  router.get(
    '/me',
    reviewerRoute(deps, async (_req, res, account) => {
      res.set('Cache-Control', 'no-store').json({ id: account.id, nickname: account.nickname });
      await Promise.resolve();
    }),
  );
  router.patch(
    '/me',
    reviewerRoute(deps, async (req, res, account) => {
      const input = z
        .object({
          nickname: textByCharacters(2, 16).refine(
            (v) => !/1\d{10}/u.test(v.normalize('NFKC')),
            'phone_not_allowed',
          ),
        })
        .safeParse(req.body);
      if (!input.success) {
        res.status(400).json(validationEnvelope(input.error));
        return;
      }
      const saved = await deps.db
        .updateTable('coach_review_accounts')
        .set(input.data)
        .where('id', '=', account.id)
        .returning(['id', 'nickname'])
        .executeTakeFirstOrThrow();
      res.json(saved);
    }),
  );
  router.get(
    '/me/reviews',
    reviewerRoute(deps, async (_req, res, account) => {
      const reviews = await publicReviews(deps.db)
        .where('coach_reviews.account_id', '=', account.id)
        .execute();
      res.set('Cache-Control', 'no-store').json({ reviews });
    }),
  );
  router.post(
    '/coaches/:id/reviews',
    reviewerRoute(deps, async (req, res, account) => {
      const input = CoachReviewInput.safeParse(req.body),
        id = Id.safeParse(req.params.id);
      if (!input.success) {
        res.status(400).json(validationEnvelope(input.error));
        return;
      }
      if (!id.success) {
        res.status(400).json(validationEnvelope(id.error));
        return;
      }
      if (!account.nickname) {
        res.status(400).json({ error: 'NICKNAME_REQUIRED' });
        return;
      }
      if (await rejectBlockedReview(deps.db, input.data.body, res)) return;
      try {
        const saved = await deps.db.transaction().execute(async (trx) => {
          const coach = await trx
            .selectFrom('listed_coaches')
            .select('id')
            .where('id', '=', id.data)
            .where('status', '=', 'published')
            .forUpdate()
            .executeTakeFirst();
          if (!coach) return null;
          return trx
            .insertInto('coach_reviews')
            .values({ ...input.data, listed_coach_id: id.data, account_id: account.id })
            .returning(['id', 'edited', 'created_at', 'updated_at'])
            .executeTakeFirstOrThrow();
        });
        if (!saved) {
          res.status(404).json({ error: 'LISTED_COACH_NOT_FOUND' });
          return;
        }
        res.status(201).json(saved);
      } catch (error) {
        if (isUniqueConflict(error)) {
          res.status(409).json({ error: 'COACH_REVIEW_EXISTS' });
          return;
        }
        throw error;
      }
    }),
  );
  router.patch(
    '/reviews/:id',
    reviewerRoute(deps, async (req, res, account) => {
      const input = CoachReviewInput.safeParse(req.body),
        id = Id.safeParse(req.params.id);
      if (!input.success) {
        res.status(400).json(validationEnvelope(input.error));
        return;
      }
      if (!id.success) {
        res.status(400).json(validationEnvelope(id.error));
        return;
      }
      if (await rejectBlockedReview(deps.db, input.data.body, res)) return;
      const saved = await deps.db.transaction().execute(async (trx) => {
        const review = await trx
          .selectFrom('coach_reviews')
          .select('listed_coach_id')
          .where('id', '=', id.data)
          .where('account_id', '=', account.id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        if (!review) return null;
        const coach = await trx
          .selectFrom('listed_coaches')
          .select('id')
          .where('id', '=', review.listed_coach_id)
          .where('status', '=', 'published')
          .forUpdate()
          .executeTakeFirst();
        if (!coach) return null;
        return trx
          .updateTable('coach_reviews')
          .set({ ...input.data, edited: true, updated_at: new Date(Date.now()) })
          .where('id', '=', id.data)
          .where('deleted_at', 'is', null)
          .returning(['id', 'edited', 'updated_at'])
          .executeTakeFirst();
      });
      if (!saved) {
        res.status(404).json({ error: 'COACH_REVIEW_NOT_FOUND' });
        return;
      }
      res.json(saved);
    }),
  );
  router.delete(
    '/reviews/:id',
    reviewerRoute(deps, async (req, res, account) => {
      const id = Id.safeParse(req.params.id);
      if (!id.success) {
        res.status(400).json(validationEnvelope(id.error));
        return;
      }
      const deleted = await deps.db
        .updateTable('coach_reviews')
        .set({ deleted_at: new Date(Date.now()), deleted_by: 'author' })
        .where('id', '=', id.data)
        .where('account_id', '=', account.id)
        .where('deleted_at', 'is', null)
        .returning('id')
        .executeTakeFirst();
      if (!deleted) {
        res.status(404).json({ error: 'COACH_REVIEW_NOT_FOUND' });
        return;
      }
      res.status(204).end();
    }),
  );
  router.use(coachReviewSubmissionsRouter(deps));
  return router;
}
