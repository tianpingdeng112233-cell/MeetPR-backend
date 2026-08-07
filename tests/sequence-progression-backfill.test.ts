import { afterEach, describe, expect, it, vi } from 'vitest';

import { createImportedHistory, getPlanWithChildren } from '../src/routes/plans';
import { createPublishedPlan, ids, makeContext } from './helpers/studentActions';

afterEach(() => {
  vi.useRealTimers();
});

describe('sequence progression imported history backfill', () => {
  it('writes one UTC-midnight completion per assumed day without double-writing', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-08-07T12:00:00Z') });
    const ctx = await makeContext();
    const fixture = await createPublishedPlan(ctx);
    const plan = await ctx.db
      .updateTable('plans')
      .set({
        start_date: '2026-08-01',
        end_date: '2026-08-31',
        published_at: new Date('2026-07-31T10:00:00Z'),
      })
      .where('id', '=', fixture.planId)
      .returningAll()
      .executeTakeFirstOrThrow();
    const futureDay = await ctx.db
      .insertInto('plan_days')
      .values({ plan_id: plan.id, week_number: 1, day_of_week: 7, sort_order: 0 })
      .returning('id')
      .executeTakeFirstOrThrow();
    const futureExercise = await ctx.db
      .insertInto('plan_exercises')
      .values({
        plan_day_id: futureDay.id,
        exercise_id: ids.exercise,
        is_main_lift: true,
        sort_order: 0,
        notes: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await ctx.db
      .insertInto('plan_sets')
      .values({
        plan_exercise_id: futureExercise.id,
        set_number: 1,
        target_reps: 5,
        target_reps_max: null,
        intensity_mode: 'weight',
        target_value: '100.00',
        set_type: 'working',
        rest_seconds: null,
      })
      .execute();

    const first = await ctx.db.transaction().execute((trx) => createImportedHistory(trx, plan));
    const second = await ctx.db.transaction().execute((trx) => createImportedHistory(trx, plan));
    const completions = await ctx.db.selectFrom('plan_day_completions').selectAll().execute();
    const detail = await getPlanWithChildren(ctx.db, plan);

    expect(first).toEqual({ created: 1, existing: 0 });
    expect(second).toEqual({ created: 0, existing: 1 });
    expect(completions).toEqual([
      expect.objectContaining({
        plan_day_id: fixture.dayId,
        student_id: ids.trainee,
        source: 'backfill',
        completed_at: new Date('2026-08-01T00:00:00.000Z'),
      }),
    ]);
    expect(detail.published_at).toBe('2026-07-31T10:00:00.000Z');
    expect(detail.days).toEqual([
      expect.objectContaining({
        id: fixture.dayId,
        completed_at: '2026-08-01T00:00:00.000Z',
        completion_source: 'backfill',
      }),
      expect.objectContaining({
        id: futureDay.id,
        completed_at: null,
        completion_source: null,
      }),
    ]);
  });

  it('derives every date from the row read under the lock, not the caller copy', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-08-07T12:00:00Z') });
    const ctx = await makeContext();
    const fixture = await createPublishedPlan(ctx);
    const stalePlan = await ctx.db
      .updateTable('plans')
      .set({ start_date: '2026-07-01', end_date: '2026-07-31' })
      .where('id', '=', fixture.planId)
      .returningAll()
      .executeTakeFirstOrThrow();
    // A concurrent PATCH commits a new start_date after the caller's read.
    await ctx.db
      .updateTable('plans')
      .set({ start_date: '2026-08-01', end_date: '2026-08-31' })
      .where('id', '=', fixture.planId)
      .execute();

    await ctx.db.transaction().execute((trx) => createImportedHistory(trx, stalePlan));

    const log = await ctx.db.selectFrom('set_logs').selectAll().executeTakeFirstOrThrow();
    const completion = await ctx.db
      .selectFrom('plan_day_completions')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(dateText(log.logged_date)).toBe('2026-08-01');
    expect(completion.completed_at).toEqual(new Date('2026-08-01T00:00:00.000Z'));
  });
});

function dateText(value: unknown): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
}
