import type { Kysely, Selectable, Transaction } from 'kysely';
import type { Database, PlansTable } from '../db/types';
import type { HandoffPlan } from '../domain/plan-handoff';
import { normalizeDateOnly } from '../utils/date';

type Db = Kysely<Database> | Transaction<Database>;
const timestamp = (value: Date | string): string => new Date(value).toISOString();

/** Three batch queries for any number of plans; free-standing adhoc logs have no plan anchor. */
export async function readHandoffPlans(
  db: Db,
  plans: readonly Selectable<PlansTable>[],
): Promise<HandoffPlan[]> {
  if (!plans.length) return [];
  const ids = plans.map((plan) => plan.id);
  const days = await db
    .selectFrom('plan_days as d')
    .leftJoin('plan_day_completions as c', 'c.plan_day_id', 'd.id')
    .select(['d.id', 'd.plan_id', 'd.is_rest', 'c.completed_at'])
    .where('d.plan_id', 'in', ids)
    .execute();
  const plannedLogs = await db
    .selectFrom('set_logs as l')
    .innerJoin('plan_exercises as e', 'e.id', 'l.plan_exercise_id')
    .innerJoin('plan_days as d', 'd.id', 'e.plan_day_id')
    .innerJoin('plans as p', 'p.id', 'd.plan_id')
    .select('d.plan_id')
    .select((eb) => eb.fn.max<Date>('l.logged_at').as('latest'))
    .where('d.plan_id', 'in', ids)
    .whereRef('l.student_id', '=', 'p.trainee_id')
    .groupBy('d.plan_id')
    .execute();
  const addedLogs = await db
    .selectFrom('set_logs as l')
    .innerJoin('plan_days as d', 'd.id', 'l.plan_day_id')
    .innerJoin('plans as p', 'p.id', 'd.plan_id')
    .select('d.plan_id')
    .select((eb) => eb.fn.max<Date>('l.logged_at').as('latest'))
    .where('d.plan_id', 'in', ids)
    .whereRef('l.student_id', '=', 'p.trainee_id')
    .groupBy('d.plan_id')
    .execute();
  const latest = new Map<string, string>();
  const record = (id: string, at: Date | string) => {
    const value = timestamp(at);
    const previous = latest.get(id);
    if (previous === undefined || value > previous) latest.set(id, value);
  };
  const daysByPlan = new Map<string, HandoffPlan['days'][number][]>();
  for (const day of days) {
    if (day.completed_at !== null) record(day.plan_id, day.completed_at);
    const list = daysByPlan.get(day.plan_id) ?? [];
    list.push({
      is_rest: day.is_rest,
      completed_at: day.completed_at === null ? null : timestamp(day.completed_at),
    });
    daysByPlan.set(day.plan_id, list);
  }
  for (const log of [...plannedLogs, ...addedLogs]) record(log.plan_id, log.latest);
  return plans.map((plan) => ({
    id: plan.id,
    start_date: normalizeDateOnly(plan.start_date),
    created_at: timestamp(plan.created_at),
    published_at: plan.published_at === null ? null : timestamp(plan.published_at),
    latest_record_at: latest.get(plan.id) ?? null,
    days: daysByPlan.get(plan.id) ?? [],
  }));
}
