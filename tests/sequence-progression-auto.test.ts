import { describe, expect, it } from 'vitest';

import { sessionProgress } from '../src/handlers/session-progress';
import { upsertAdhocSetLog, upsertSetLog } from '../src/handlers/sets-log';
import { createPublishedPlan, ids, makeContext } from './helpers/studentActions';

function coachedInput(
  plan: { planId: string; dayId: string; planExerciseId: string },
  setIndex: number,
  completed: boolean,
  failed: boolean,
) {
  return {
    plan_id: plan.planId,
    plan_day_id: plan.dayId,
    plan_exercise_id: plan.planExerciseId,
    exercise_id: ids.exercise,
    logged_date: '2026-08-07',
    update_logged_date: true,
    set_index: setIndex,
    weight_kg: '100.00',
    reps: 5,
    rpe: null,
    completed,
    failed,
  };
}

// Settlement stays student-explicit: logging the final prescribed set never
// auto-completes the day (David 2026-08-08, revising 拍板 1's auto half).
describe('sequence progression settlement', () => {
  it('does not auto-complete after the failed final prescribed set', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);

    await upsertSetLog(ctx.db, ids.trainee, coachedInput(plan, 0, false, true));

    expect(await ctx.db.selectFrom('plan_day_completions').selectAll().execute()).toHaveLength(0);
  });

  it('does not auto-complete even when every prescribed set is recorded', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await ctx.db
      .insertInto('plan_sets')
      .values({
        plan_exercise_id: plan.planExerciseId,
        set_number: 2,
        target_reps: 5,
        target_reps_max: null,
        intensity_mode: 'weight',
        target_value: '100.00',
        set_type: 'working',
        rest_seconds: null,
      })
      .execute();

    await upsertSetLog(ctx.db, ids.trainee, coachedInput(plan, 0, true, false));
    expect(await ctx.db.selectFrom('plan_day_completions').selectAll().execute()).toHaveLength(0);

    await upsertSetLog(ctx.db, ids.trainee, coachedInput(plan, 1, true, false));
    expect(await ctx.db.selectFrom('plan_day_completions').selectAll().execute()).toHaveLength(0);
  });

  it('never lets an adhoc log complete a prescribed plan day', async () => {
    const ctx = await makeContext();
    await createPublishedPlan(ctx);

    await upsertAdhocSetLog(ctx.db, ids.trainee, {
      exercise_id: ids.exercise,
      logged_date: '2026-08-07',
      set_index: 0,
      weight_kg: '100.00',
      reps: 5,
      rpe: null,
      completed: true,
      failed: false,
    });

    expect(await ctx.db.selectFrom('plan_day_completions').selectAll().execute()).toHaveLength(0);
  });

  it('leaves a zero-prescription day for explicit manual completion', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await ctx.db
      .deleteFrom('plan_sets')
      .where('plan_exercise_id', '=', plan.planExerciseId)
      .execute();

    await upsertSetLog(ctx.db, ids.trainee, coachedInput(plan, 0, true, false));

    expect(await ctx.db.selectFrom('plan_day_completions').selectAll().execute()).toHaveLength(0);
  });

  it('keeps the pre-extraction ledger semantics: zero-prescription day is plannedComplete', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await ctx.db
      .deleteFrom('plan_sets')
      .where('plan_exercise_id', '=', plan.planExerciseId)
      .execute();
    await upsertSetLog(ctx.db, ids.trainee, coachedInput(plan, 0, true, false));

    const progress = await sessionProgress(ctx.db, [
      { plan_exercise_id: plan.planExerciseId, completed: true, failed: false },
    ]);

    expect(progress.plannedComplete).toBe(true);
    expect(progress.prescribedSetCount).toBe(0);
  });
});
