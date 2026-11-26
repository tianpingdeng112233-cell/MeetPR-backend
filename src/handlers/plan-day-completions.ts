import type { Selectable, Transaction } from 'kysely';

import type { Database, PlanDayCompletionsTable, PlanDaysTable, PlansTable } from '../db/types';
import { normalizeDateOnly, trainingDay } from '../utils/date';
import { uuidEquals } from '../utils/uuid';

const COMPLETION_UNDO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type PlanRow = Selectable<PlansTable>;
type PlanDayRow = Selectable<PlanDaysTable>;
type PlanDayCompletionRow = Selectable<PlanDayCompletionsTable>;

export type CompletionCommandError = 'NOT_PLAN_STUDENT' | 'PLAN_NOT_ACTIVE' | 'PLAN_DAY_REST';

async function lockCompletionContext(
  db: Transaction<Database>,
  dayId: string,
  studentId: string,
): Promise<
  | { type: 'context'; plan: PlanRow; day: PlanDayRow }
  | { type: 'error'; error: CompletionCommandError }
> {
  const day = await db
    .selectFrom('plan_days')
    .selectAll()
    .where('id', '=', dayId)
    .executeTakeFirst();
  if (!day) return { type: 'error', error: 'NOT_PLAN_STUDENT' };

  // Interactive completion writers use the plan -> day lock order. The plan
  // lock serializes latest-completion undo against completion on another day.
  const plan = await db
    .selectFrom('plans as p')
    .selectAll('p')
    .where('p.id', '=', day.plan_id)
    // Lock only the plan; calendar writers acquire the student scope before it.
    .forUpdate()
    .executeTakeFirst();
  if (!plan || !uuidEquals(plan.trainee_id, studentId)) {
    return { type: 'error', error: 'NOT_PLAN_STUDENT' };
  }
  if (plan.status !== 'published') {
    return { type: 'error', error: 'PLAN_NOT_ACTIVE' };
  }

  const lockedDay = await db
    .selectFrom('plan_days')
    .selectAll()
    .where('id', '=', dayId)
    .where('plan_id', '=', plan.id)
    .forUpdate()
    .executeTakeFirst();
  if (lockedDay?.is_rest || lockedDay?.is_placeholder)
    return { type: 'error', error: 'PLAN_DAY_REST' };
  return lockedDay
    ? { type: 'context', plan, day: lockedDay }
    : { type: 'error', error: 'NOT_PLAN_STUDENT' };
}

export async function manuallyCompletePlanDay(
  db: Transaction<Database>,
  dayId: string,
  studentId: string,
  actualCompletionDate?: string,
): Promise<
  | { type: 'completed'; completion: PlanDayCompletionRow }
  | { type: 'error'; error: CompletionCommandError | 'FUTURE_COMPLETION_DATE' }
> {
  const context = await lockCompletionContext(db, dayId, studentId);
  if (context.type === 'error') return context;

  const existing = await db
    .selectFrom('plan_day_completions')
    .selectAll()
    .where('plan_day_id', '=', dayId)
    .executeTakeFirst();
  // An identical retry remains successful even after the athlete changes timezone.
  const recordedDate = existing?.actual_completion_date;
  if (
    actualCompletionDate !== undefined &&
    (recordedDate == null || normalizeDateOnly(recordedDate) !== actualCompletionDate)
  ) {
    const athlete = await db
      .selectFrom('users')
      .select('timezone')
      .where('id', '=', studentId)
      .executeTakeFirstOrThrow();
    if (actualCompletionDate > trainingDay(new Date(), athlete.timezone)) {
      return { type: 'error', error: 'FUTURE_COMPLETION_DATE' };
    }
  }

  if (existing) return { type: 'completed', completion: existing };

  const inserted = await db
    .insertInto('plan_day_completions')
    .values({
      plan_day_id: dayId,
      student_id: studentId,
      source: 'manual',
      actual_completion_date: actualCompletionDate ?? null,
    })
    .onConflict((oc) => oc.column('plan_day_id').doNothing())
    .returningAll()
    .executeTakeFirst();
  const completion =
    inserted ??
    (await db
      .selectFrom('plan_day_completions')
      .selectAll()
      .where('plan_day_id', '=', dayId)
      .executeTakeFirstOrThrow());
  return { type: 'completed', completion };
}

export type UndoCompletionError =
  | CompletionCommandError
  | 'NO_COMPLETION_TO_UNDO'
  | 'NOT_LATEST_COMPLETION'
  | 'UNDO_WINDOW_PASSED';

export async function undoPlanDayCompletion(
  db: Transaction<Database>,
  dayId: string,
  studentId: string,
  now: Date,
): Promise<{ type: 'deleted' } | { type: 'error'; error: UndoCompletionError }> {
  const context = await lockCompletionContext(db, dayId, studentId);
  if (context.type === 'error') return context;

  const completion = await db
    .selectFrom('plan_day_completions')
    .selectAll()
    .where('plan_day_id', '=', dayId)
    .where('student_id', '=', studentId)
    .forUpdate()
    .executeTakeFirst();
  if (!completion) return { type: 'error', error: 'NO_COMPLETION_TO_UNDO' };

  const latest = await db
    .selectFrom('plan_day_completions as pdc')
    .innerJoin('plan_days as pd', 'pd.id', 'pdc.plan_day_id')
    .select('pdc.id')
    .where('pd.plan_id', '=', context.plan.id)
    .where('pdc.student_id', '=', studentId)
    .orderBy('pdc.completed_at', 'desc')
    .orderBy('pdc.id', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (latest?.id !== completion.id) {
    return { type: 'error', error: 'NOT_LATEST_COMPLETION' };
  }
  if (now.getTime() - completion.completed_at.getTime() >= COMPLETION_UNDO_WINDOW_MS) {
    return { type: 'error', error: 'UNDO_WINDOW_PASSED' };
  }

  await db.deleteFrom('plan_day_completions').where('id', '=', completion.id).execute();
  return { type: 'deleted' };
}
