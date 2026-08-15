import { describe, expect, it } from 'vitest';

import {
  manuallyCompletePlanDay,
  undoPlanDayCompletion,
} from '../src/handlers/plan-day-completions';
import { createPublishedPlan, ids, makeContext } from './helpers/studentActions';

async function addEmptyDay(db: Awaited<ReturnType<typeof makeContext>>['db'], planId: string) {
  return db
    .insertInto('plan_days')
    .values({ plan_id: planId, week_number: 1, day_of_week: 2, sort_order: 0 })
    .returning('id')
    .executeTakeFirstOrThrow();
}

describe('plan-day manual completion transaction', () => {
  it('is idempotent and permits a day with zero prescribed sets', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await ctx.db
      .deleteFrom('plan_sets')
      .where('plan_exercise_id', '=', plan.planExerciseId)
      .execute();

    const first = await ctx.db
      .transaction()
      .execute((trx) => manuallyCompletePlanDay(trx, plan.dayId, ids.trainee));
    const second = await ctx.db
      .transaction()
      .execute((trx) => manuallyCompletePlanDay(trx, plan.dayId, ids.trainee));

    expect(first.type).toBe('completed');
    expect(second).toEqual(first);
    expect(await ctx.db.selectFrom('plan_day_completions').selectAll().execute()).toHaveLength(1);
  });

  it('enforces student ownership and published status', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);

    const otherStudent = await ctx.db
      .transaction()
      .execute((trx) => manuallyCompletePlanDay(trx, plan.dayId, ids.otherStudent));
    expect(otherStudent).toEqual({ type: 'error', error: 'NOT_PLAN_STUDENT' });

    await ctx.db
      .updateTable('plans')
      .set({ status: 'paused' })
      .where('id', '=', plan.planId)
      .execute();
    const inactive = await ctx.db
      .transaction()
      .execute((trx) => manuallyCompletePlanDay(trx, plan.dayId, ids.trainee));
    expect(inactive).toEqual({ type: 'error', error: 'PLAN_NOT_ACTIVE' });
  });
});

describe('plan-day completion undo transaction', () => {
  it('rejects a non-latest completion and deletes the latest one', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    const secondDay = await addEmptyDay(ctx.db, plan.planId);
    await ctx.db
      .insertInto('plan_day_completions')
      .values([
        {
          plan_day_id: plan.dayId,
          student_id: ids.trainee,
          source: 'manual',
          completed_at: new Date('2026-08-07T00:00:00Z'),
        },
        {
          plan_day_id: secondDay.id,
          student_id: ids.trainee,
          source: 'auto',
          completed_at: new Date('2026-08-07T01:00:00Z'),
        },
      ])
      .execute();

    const older = await ctx.db
      .transaction()
      .execute((trx) =>
        undoPlanDayCompletion(trx, plan.dayId, ids.trainee, new Date('2026-08-07T02:00:00Z')),
      );
    expect(older).toEqual({ type: 'error', error: 'NOT_LATEST_COMPLETION' });

    const latest = await ctx.db
      .transaction()
      .execute((trx) =>
        undoPlanDayCompletion(trx, secondDay.id, ids.trainee, new Date('2026-08-07T02:00:00Z')),
      );
    expect(latest).toEqual({ type: 'deleted' });
  });

  it.each([
    ['Asia/Shanghai', '2026-07-12T19:59:59Z', '2026-07-12T20:00:00Z'],
    ['Europe/London', '2026-01-13T03:59:59Z', '2026-01-13T04:00:00Z'],
    ['Europe/London', '2026-07-13T02:59:59Z', '2026-07-13T03:00:00Z'],
    ['America/New_York', '2026-07-13T07:59:59Z', '2026-07-13T08:00:00Z'],
  ])(
    'changes the %s gym-day exactly at 04:00 and reports missing completion',
    async (timezone, before, at) => {
      const ctx = await makeContext();
      const plan = await createPublishedPlan(ctx);
      await ctx.db.updateTable('users').set({ timezone }).where('id', '=', ids.trainee).execute();
      const completedAt = new Date(before);
      await ctx.db
        .insertInto('plan_day_completions')
        .values({
          plan_day_id: plan.dayId,
          student_id: ids.trainee,
          source: 'manual',
          completed_at: completedAt,
        })
        .execute();

      const crossedCutoff = await ctx.db
        .transaction()
        .execute((trx) => undoPlanDayCompletion(trx, plan.dayId, ids.trainee, new Date(at)));
      expect(crossedCutoff).toEqual({ type: 'error', error: 'UNDO_WINDOW_PASSED' });

      const sameGymDay = await ctx.db
        .transaction()
        .execute((trx) => undoPlanDayCompletion(trx, plan.dayId, ids.trainee, completedAt));
      expect(sameGymDay).toEqual({ type: 'deleted' });

      const missing = await ctx.db
        .transaction()
        .execute((trx) => undoPlanDayCompletion(trx, plan.dayId, ids.trainee, completedAt));
      expect(missing).toEqual({ type: 'error', error: 'NO_COMPLETION_TO_UNDO' });
    },
  );
});
