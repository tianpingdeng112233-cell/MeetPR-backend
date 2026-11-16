import type { ErrorRequestHandler } from 'express';
import type { Selectable, Transaction } from 'kysely';
import type { Database, PlansTable, PlanDaysTable } from '../db/types';
import { effectivePlanDays, type CalendarPlanDayShift } from '../domain/plan-calendar';
import { normalizeDateOnly, utcDate } from '../utils/date';

type Plan = Selectable<PlansTable>;
type Day = Selectable<PlanDaysTable>;
interface Range {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
}
interface CalendarChange {
  plan: Plan;
  days: Day[];
  shifts: CalendarPlanDayShift[];
  siblings: Range[];
}

function range(plan: Plan, days: readonly Day[], shifts: readonly CalendarPlanDayShift[]): Range {
  return {
    id: plan.id,
    name: plan.name,
    start_date: normalizeDateOnly(plan.start_date),
    end_date: effectivePlanDays(
      plan,
      days.filter((day) => !day.is_rest),
      shifts,
    ).reduce(
      (end, day) => (day.effectiveDate > end ? day.effectiveDate : end),
      normalizeDateOnly(plan.end_date),
    ),
  };
}

/** Lock the shared student before plan/day locks. NO KEY UPDATE permits FK checks by set-log writers. */
export async function lockPlanCalendarChange(
  db: Transaction<Database>,
  planId: string,
  coachId: string,
): Promise<CalendarChange | null> {
  const owner = await db
    .selectFrom('plans')
    .select('trainee_id')
    .where('id', '=', planId)
    .where('coach_id', '=', coachId)
    .executeTakeFirst();
  if (!owner) return null;
  await db
    .selectFrom('users')
    .select('id')
    .where('id', '=', owner.trainee_id)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();
  const plan = await db
    .selectFrom('plans')
    .selectAll()
    .where('id', '=', planId)
    .where('coach_id', '=', coachId)
    .forUpdate()
    .executeTakeFirst();
  if (!plan) return null;
  const siblings = await db
    .selectFrom('plans')
    .selectAll()
    .where('trainee_id', '=', plan.trainee_id)
    .where('coach_id', '=', coachId)
    .where('status', '=', 'published')
    .where('id', '!=', planId)
    .execute();
  const ids = [plan.id, ...siblings.map((item) => item.id)];
  const days = await db.selectFrom('plan_days').selectAll().where('plan_id', 'in', ids).execute();
  const shifts = await db
    .selectFrom('plan_day_shifts as s')
    .innerJoin('plan_days as d', 'd.id', 's.plan_day_id')
    .selectAll('s')
    .select('d.plan_id')
    .where('d.plan_id', 'in', ids)
    .execute();
  const daysByPlan = new Map<string, Day[]>();
  const shiftsByPlan = new Map<string, CalendarPlanDayShift[]>();
  for (const day of days) {
    const group = daysByPlan.get(day.plan_id) ?? [];
    group.push(day);
    daysByPlan.set(day.plan_id, group);
  }
  for (const shift of shifts) {
    const group = shiftsByPlan.get(shift.plan_id) ?? [];
    group.push({ ...shift, seq: Number(shift.seq) });
    shiftsByPlan.set(shift.plan_id, group);
  }
  return {
    plan,
    days: daysByPlan.get(plan.id) ?? [],
    shifts: shiftsByPlan.get(plan.id) ?? [],
    siblings: siblings.map((item) =>
      range(item, daysByPlan.get(item.id) ?? [], shiftsByPlan.get(item.id) ?? []),
    ),
  };
}

class PlanDatesOverlap extends Error {
  constructor(
    readonly conflicts: Range[],
    readonly requiredShiftDays?: number,
  ) {
    super('PLAN_DATES_OVERLAP');
  }
}

/** Reject only newly covered overlap dates, leaving existing overlaps editable. Runs before writes. */
export function assertPlanDates(
  change: CalendarChange,
  plan: Plan,
  days = change.days,
  shifts = change.shifts,
  shifting = false,
): void {
  if (plan.status !== 'published') return;
  const before = range(change.plan, change.days, change.shifts);
  const after = range(plan, days, shifts);
  const conflicts = change.siblings
    .filter((other) => {
      const lo = after.start_date > other.start_date ? after.start_date : other.start_date;
      const hi = after.end_date < other.end_date ? after.end_date : other.end_date;
      if (lo > hi) return false;
      if (change.plan.status !== 'published') return true;
      const oldLo = before.start_date > other.start_date ? before.start_date : other.start_date;
      const oldHi = before.end_date < other.end_date ? before.end_date : other.end_date;
      return oldLo > oldHi || lo < oldLo || hi > oldHi;
    })
    .sort((a, b) => a.start_date.localeCompare(b.start_date) || a.id.localeCompare(b.id));
  if (!conflicts.length) return;
  const required = shifting
    ? Math.max(
        0,
        ...conflicts.map(
          (other) =>
            Math.floor(
              (utcDate(after.end_date).getTime() - utcDate(other.start_date).getTime()) / 86400000,
            ) + 1,
        ),
      )
    : undefined;
  throw new PlanDatesOverlap(conflicts, required);
}

export const planDatesErrorHandler: ErrorRequestHandler = (error: unknown, _req, res, next) => {
  if (!(error instanceof PlanDatesOverlap)) {
    next(error);
    return;
  }
  res.status(409).json({
    error: 'PLAN_DATES_OVERLAP',
    conflicts: error.conflicts,
    ...(error.requiredShiftDays === undefined
      ? {}
      : { required_shift_days: error.requiredShiftDays }),
  });
};
