import { Router } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../db/types';
import { Id } from '../services/coach-reviews/schema';
import { route, validationEnvelope } from './http';
export function adminCoachReviewReportsRouter(db: Kysely<Database>) {
  const router = Router();
  router.get(
    '/reports',
    route(async (_req, res) => {
      const rows = await db
        .selectFrom('coach_review_reports')
        .innerJoin('coach_reviews', 'coach_reviews.id', 'coach_review_reports.review_id')
        .select([
          'coach_review_reports.id',
          'coach_review_reports.review_id',
          'coach_review_reports.reason',
          'coach_review_reports.explanation',
          'coach_review_reports.created_at',
          'coach_reviews.body',
          'coach_reviews.listed_coach_id',
          'coach_reviews.deleted_at',
        ])
        .where('coach_review_reports.closed_at', 'is', null)
        .orderBy('coach_review_reports.created_at')
        .execute();
      const groups = new Map<
        string,
        {
          review_id: string;
          listed_coach_id: string;
          body: string;
          deleted_at: Date | null;
          report_count: number;
          first_reported_at: Date;
          age_seconds: number;
          overdue: boolean;
          reasons: { id: string; reason: string; explanation: string | null }[];
        }
      >();
      for (const row of rows) {
        let group = groups.get(row.review_id);
        if (!group) {
          const age = Math.max(
            0,
            Math.floor((Date.now() - new Date(row.created_at).getTime()) / 1000),
          );
          group = {
            review_id: row.review_id,
            listed_coach_id: row.listed_coach_id,
            body: row.body,
            deleted_at: row.deleted_at,
            report_count: 0,
            first_reported_at: row.created_at,
            age_seconds: age,
            overdue: age > 3 * 24 * 60 * 60,
            reasons: [],
          };
          groups.set(row.review_id, group);
        }
        group.report_count++;
        group.reasons.push({ id: row.id, reason: row.reason, explanation: row.explanation });
      }
      res.json({ reports: [...groups.values()] });
    }),
  );
  router.post(
    '/reports/:id/decision',
    route(async (req, res) => {
      const id = Id.safeParse(req.params.id),
        input = z.object({ action: z.enum(['keep', 'delete']) }).safeParse(req.body);
      if (!id.success) {
        res.status(400).json(validationEnvelope(id.error));
        return;
      }
      if (!input.success) {
        res.status(400).json(validationEnvelope(input.error));
        return;
      }
      const result = await db.transaction().execute(async (trx) => {
        const review = await trx
          .selectFrom('coach_reviews')
          .select('id')
          .where('id', '=', id.data)
          .forUpdate()
          .executeTakeFirst();
        if (!review) return false;
        const report = await trx
          .selectFrom('coach_review_reports')
          .select('id')
          .where('review_id', '=', id.data)
          .where('closed_at', 'is', null)
          .executeTakeFirst();
        if (!report) return false;
        const now = new Date(Date.now());
        if (input.data.action === 'delete')
          await trx
            .updateTable('coach_reviews')
            .set({ deleted_at: now, deleted_by: `admin:${req.user?.id ?? ''}` })
            .where('id', '=', id.data)
            .where('deleted_at', 'is', null)
            .execute();
        await trx
          .updateTable('coach_review_reports')
          .set({ closed_at: now, decision: input.data.action, decided_by: req.user?.id ?? null })
          .where('review_id', '=', id.data)
          .where('closed_at', 'is', null)
          .execute();
        return true;
      });
      if (!result) {
        res.status(409).json({ error: 'COACH_REVIEW_NO_OPEN_REPORTS' });
        return;
      }
      res.json({ action: input.data.action });
    }),
  );
  return router;
}
