import { Router } from 'express';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { Database } from '../db/types';
import { buildOverviewAlerts } from '../domain/overview-alerts';
import { requireRole } from '../middleware/auth';
import { utcDate, utcDateOnly } from '../utils/date';
import { route, validationEnvelope } from './http';

const StudentIdParamsSchema = z.object({ studentId: z.string().uuid() });

export function coachOverviewAlertsRouter({ db }: { db: Kysely<Database> }): Router {
  const router = Router();
  router.post(
    '/students/:studentId/plan-viewed',
    requireRole('coach'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }
      const params = StudentIdParamsSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }
      const bound = await db
        .selectFrom('bind_requests')
        .select('id')
        .where('coach_id', '=', req.user.id)
        .where('student_id', '=', params.data.studentId)
        .where('status', '=', 'accepted')
        .executeTakeFirst();
      if (!bound) {
        res.status(403).json({ error: 'AUTHORIZATION_FORBIDDEN' });
        return;
      }
      await db
        .insertInto('coach_student_plan_views')
        .values({
          coach_id: req.user.id,
          student_id: params.data.studentId,
          seen_at: sql<Date>`now()`,
        })
        .onConflict((oc) =>
          oc.columns(['coach_id', 'student_id']).doUpdateSet({ seen_at: sql<Date>`now()` }),
        )
        .execute();
      res.status(204).end();
    }),
  );

  router.get(
    '/overview-alerts',
    requireRole('coach'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }
      const now = new Date();
      const coachId = req.user.id;
      const students = await db
        .selectFrom('users as student')
        .innerJoin('bind_requests as br', 'br.student_id', 'student.id')
        .select(['student.id', 'student.timezone'])
        .distinct()
        .where('br.coach_id', '=', coachId)
        .where('br.status', '=', 'accepted')
        .execute();
      const empty = {
        now,
        students,
        views: [],
        plans: [],
        days: [],
        sets: [],
        logs: [],
        completions: [],
        shifts: [],
      };
      if (students.length === 0) {
        res.json(buildOverviewAlerts(empty));
        return;
      }
      const studentIds = students.map((student) => student.id);
      const earliestPlanEnd = utcDate(now);
      earliestPlanEnd.setUTCDate(earliestPlanEnd.getUTCDate() - 22);
      const [plans, views] = await Promise.all([
        db
          .selectFrom('plans')
          .select(['id', 'trainee_id', 'name', 'status', 'start_date', 'end_date'])
          .where('coach_id', '=', coachId)
          .where('trainee_id', 'in', studentIds)
          .where('end_date', '>=', utcDateOnly(earliestPlanEnd))
          .execute(),
        db
          .selectFrom('coach_student_plan_views')
          .select(['student_id', 'seen_at'])
          .where('coach_id', '=', coachId)
          .where('student_id', 'in', studentIds)
          .execute(),
      ]);
      if (plans.length === 0) {
        res.json(buildOverviewAlerts({ ...empty, views }));
        return;
      }
      const planIds = plans.map((plan) => plan.id);
      const days = await db
        .selectFrom('plan_days')
        .select(['id', 'plan_id', 'week_number', 'day_of_week'])
        .where('plan_id', 'in', planIds)
        .execute();
      if (days.length === 0) {
        res.json(buildOverviewAlerts({ ...empty, plans, views }));
        return;
      }
      const dayIds = days.map((day) => day.id);
      // Retain old logs as completion evidence: dropping them before the policy
      // runs would turn previously completed prescriptions into missing sets.
      const [sets, logs, completions, shifts] = await Promise.all([
        db
          .selectFrom('plan_sets as ps')
          .innerJoin('plan_exercises as pe', 'pe.id', 'ps.plan_exercise_id')
          .select([
            'ps.plan_exercise_id',
            'pe.plan_day_id',
            'pe.exercise_id',
            'ps.set_number',
            'ps.load_mode',
            'ps.target_rpe',
            'ps.rpe_high',
          ])
          .where('pe.plan_day_id', 'in', dayIds)
          .execute(),
        db
          .selectFrom('set_logs as sl')
          .innerJoin('plan_exercises as pe', 'pe.id', 'sl.plan_exercise_id')
          .select([
            'sl.student_id',
            'sl.plan_exercise_id',
            'sl.set_index',
            'sl.rpe',
            'sl.coach_rpe',
            'sl.completed',
            'sl.failed',
            'sl.logged_date',
            'sl.logged_at',
          ])
          .where('pe.plan_day_id', 'in', dayIds)
          .where('sl.student_id', 'in', studentIds)
          .execute(),
        db
          .selectFrom('plan_day_completions')
          .select(['student_id', 'plan_day_id', 'completed_at'])
          .where('plan_day_id', 'in', dayIds)
          .where('student_id', 'in', studentIds)
          .execute(),
        db
          .selectFrom('plan_day_shifts')
          .select(['id', 'seq', 'plan_day_id', 'batch_id', 'shifted_to_date', 'created_at'])
          .where('plan_day_id', 'in', dayIds)
          .execute(),
      ]);
      res.json(
        buildOverviewAlerts({
          now,
          students,
          views,
          plans,
          days,
          sets,
          logs,
          completions,
          shifts: shifts.map((shift) => ({ ...shift, seq: Number(shift.seq) })),
        }),
      );
    }),
  );
  return router;
}
