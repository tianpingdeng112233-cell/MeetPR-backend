import { fetchCoachPageStats } from '../handlers/coach-page-stats';
import { publicVerifiedStats } from '../domain/coach-page-stats';
import { z } from 'zod';
import type { Config } from '../config';
import type { Logger } from '../logger';
import { createPublicRateLimit } from '../middleware/rateLimit';
import { createCoachEnquiry, notifyCoachEnquiry } from '../handlers/coach-enquiries';
import { validationEnvelope } from './http';
import { Router } from 'express';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types';
import { publicPage, selfDescription, visiblePages } from '../handlers/coach-pages';
import { resolveCanonicalAcceptedBonds } from '../db/bonds';
import { pageRoute } from './coach-page-http';

export function publicRouter({
  db,
  config,
  logger,
}: {
  db: Kysely<Database>;
  config: Config;
  logger: Logger;
}) {
  const router = Router();
  router.use(createPublicRateLimit());
  router.get(
    '/coaches',
    pageRoute(async (_req, res) => {
      const pages = await visiblePages(db).orderBy('cp.listed_at').orderBy('cp.coach_id').execute();
      if (pages.length === 0) {
        res.json({ total: 0, coaches: [] });
        return;
      }
      const bonds = await db
        .selectFrom('bind_requests')
        .select('student_id')
        .where('status', '=', 'accepted')
        .where(
          'coach_id',
          'in',
          pages.map((page) => page.coach_id),
        )
        .execute();
      const canonical = await resolveCanonicalAcceptedBonds(db, [
        ...new Set(bonds.map((b) => b.student_id)),
      ]);
      res.json({
        total: pages.length,
        coaches: pages.map((page) => ({
          slug: page.slug,
          display_name: page.display_name,
          avatar_url: null,
          headline: page.headline,
          specialties: page.specialties,
          active_student_count: canonical.filter((b) => b.coach_id === page.coach_id).length,
        })),
      });
    }),
  );
  router.get(
    '/coaches/:slug',
    pageRoute(async (req, res) => {
      const page = await publicPage(db, req.params.slug ?? '');
      const now = new Date();
      res.json({
        ...selfDescription(page),
        verified_stats: publicVerifiedStats(await fetchCoachPageStats(db, page.coach_id, now)),
        accepting_enquiries: true,
        data_as_of: now.toISOString(),
      });
    }),
  );
  router.post(
    '/coaches/:slug/enquiries',
    pageRoute(async (req, res) => {
      await publicPage(db, req.params.slug ?? '');
      // Treat a populated trap as success before form validation, without storing or emailing.
      const trap = z.object({ website: z.string().min(1) }).safeParse(req.body);
      if (trap.success) {
        res.status(201).end();
        return;
      }
      const score = z.number().min(0).max(600).nullable().optional();
      const parsed = z
        .object({
          name: z.string().trim().min(1).max(30),
          contact: z.string().trim().min(1).max(100),
          squat_kg: score,
          bench_kg: score,
          deadlift_kg: score,
          goal: z.string().trim().max(500).optional(),
          consent: z.literal(true),
          website: z.string().max(200).optional(),
        })
        .strict()
        .safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json(validationEnvelope(parsed.error));
        return;
      }
      const coachId = await createCoachEnquiry(
        db,
        req.params.slug ?? '',
        req.ip ?? 'unknown',
        parsed.data,
        config,
      );
      await notifyCoachEnquiry(db, coachId, config, logger);
      res.status(201).end();
    }),
  );
  return router;
}
