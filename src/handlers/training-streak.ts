import type { Kysely } from 'kysely';

import type { Database } from '../db/types';
import { computeTrainingStreak, type TrainingStreakResult } from '../domain/training-streak';
import { effectivePlanDays } from '../domain/plan-calendar';
import { normalizeDateOnly } from '../utils/date';

export async function getStudentTrainingStreak(
  db: Kysely<Database>,
  studentId: string,
  asOf: string,
): Promise<TrainingStreakResult> {
  // A training_sessions row exists only for a non-assumed set log. All three
  // statuses mean the student showed up: in_progress counts from the first
  // set, completed counts normally, and partial is not downgraded.
  const [sessionRows, plans, incompleteEvaluation] = await Promise.all([
    db
      .selectFrom('training_sessions')
      .select('session_date')
      .where('student_id', '=', studentId)
      .where('session_date', '<=', asOf)
      .orderBy('session_date', 'desc')
      .execute(),
    // Missed-training signals are plan/coach scoped for attribution. This
    // student-owned read model has no attribution concern, so it deliberately
    // unions every published plan without filtering to accepted coaches.
    db
      .selectFrom('plans')
      .select(['id', 'start_date', 'status'])
      .where('trainee_id', '=', studentId)
      .where('status', '=', 'published')
      .execute(),
    db
      .selectFrom('evaluation_periods')
      .select('id')
      .where('student_id', '=', studentId)
      .where('completed_at', 'is', null)
      .executeTakeFirst(),
  ]);

  const planIds = plans.map((plan) => plan.id);
  const days =
    planIds.length === 0
      ? []
      : await db
          .selectFrom('plan_days')
          .select(['id', 'plan_id', 'week_number', 'day_of_week'])
          .where('plan_id', 'in', planIds)
          .execute();
  const dayIds = days.map((day) => day.id);
  const shiftRows =
    dayIds.length === 0
      ? []
      : await db
          .selectFrom('plan_day_shifts')
          .select(['id', 'seq', 'plan_day_id', 'batch_id', 'shifted_to_date', 'created_at'])
          .where('plan_day_id', 'in', dayIds)
          .execute();

  const daysByPlan = new Map<string, typeof days>();
  for (const day of days) {
    const planDays = daysByPlan.get(day.plan_id) ?? [];
    planDays.push(day);
    daysByPlan.set(day.plan_id, planDays);
  }

  // Normalize every database DATE before comparison. node-postgres returns
  // strings while pg-mem returns Date objects for the same columns.
  const normalizedShifts = shiftRows.map((shift) => ({
    ...shift,
    seq: Number(shift.seq),
    shifted_to_date: normalizeDateOnly(shift.shifted_to_date),
  }));
  const plannedDates = new Set<string>();
  for (const plan of plans) {
    // Shift handling belongs solely to effectivePlanDays: the original date
    // disappears and its destination becomes due, so no streak-specific shift
    // branch is needed or allowed.
    const effectiveDays = effectivePlanDays(
      { start_date: normalizeDateOnly(plan.start_date) },
      daysByPlan.get(plan.id) ?? [],
      normalizedShifts,
    );
    for (const day of effectiveDays) {
      if (day.effectiveDate <= asOf) plannedDates.add(day.effectiveDate);
    }
  }

  return computeTrainingStreak({
    asOf,
    sessionDates: sessionRows.map((row) => normalizeDateOnly(row.session_date)),
    plannedDates: [...plannedDates],
    // Daily settlement already exempts every incomplete evaluation from
    // missed-training judgement. Streak uses the same definition, while its
    // pure function still applies the independent maximum-gap fallback.
    evaluationExempt: incompleteEvaluation !== undefined,
  });
}
