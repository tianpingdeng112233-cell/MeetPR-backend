import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from './helpers/inMemoryRequest';
import { auth, createPublishedPlan, ids, makeContext } from './helpers/studentActions';

afterEach(() => vi.useRealTimers());

describe('GET /students/:id/plan-days/:planDayId/weight-suggestions', () => {
  it('matches the same ordinal across plans and picks the latest eligible logged_at', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-10T12:00:00Z'));
    const ctx = await makeContext();
    const today = await createPublishedPlan(ctx);
    await ctx.db
      .updateTable('plan_sets')
      .set({ intensity_mode: 'rpe', target_value: '8.00' })
      .where('plan_exercise_id', '=', today.planExerciseId)
      .execute();
    const target = await ctx.db
      .selectFrom('plan_sets')
      .select('id')
      .where('plan_exercise_id', '=', today.planExerciseId)
      .executeTakeFirstOrThrow();
    let expectedId = '';
    for (const [index, scenario] of [
      'older',
      'match',
      'wrong-position',
      'wrong-reps',
      'failed',
      'assumed',
      'adhoc',
      'null',
      'today',
      'incomplete',
      'wrong-rpe',
      'foreign',
    ].entries()) {
      const plan = await createPublishedPlan(
        ctx,
        ids.coach,
        scenario === 'foreign' ? ids.otherStudent : ids.trainee,
      );
      // Gaps in sort_order must not be mistaken for ordinal positions.
      await ctx.db
        .updateTable('plan_exercises')
        .set({ sort_order: 50 })
        .where('id', '=', plan.planExerciseId)
        .execute();
      if (scenario === 'wrong-position') {
        await ctx.db
          .insertInto('plan_exercises')
          .values({
            plan_day_id: plan.dayId,
            exercise_id: ids.exercise,
            sort_order: 10,
            is_main_lift: true,
          })
          .execute();
      }
      const log = await ctx.db
        .insertInto('set_logs')
        .values({
          student_id: scenario === 'foreign' ? ids.otherStudent : ids.trainee,
          plan_exercise_id: scenario === 'adhoc' ? null : plan.planExerciseId,
          plan_day_id: scenario === 'adhoc' ? plan.dayId : null,
          exercise_id: ids.exercise,
          set_index: 0,
          weight_kg: scenario === 'null' ? null : scenario === 'match' ? '102.50' : '200',
          reps: scenario === 'wrong-reps' ? 3 : 5,
          rpe: scenario === 'wrong-rpe' ? '9' : '8.0',
          completed: scenario !== 'incomplete',
          failed: scenario === 'failed',
          assumed: scenario === 'assumed',
          adhoc: scenario === 'adhoc',
          logged_date: scenario === 'today' ? '2026-11-10' : '2026-11-03',
          logged_at: new Date(`2026-11-09T${String(index).padStart(2, '0')}:00:00Z`),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      if (scenario === 'match') expectedId = log.id;
    }
    for (const token of [ctx.traineeToken, ctx.coachToken]) {
      const response = await request(ctx.app)
        .get(`/students/${ids.trainee}/plan-days/${today.dayId}/weight-suggestions`)
        .set(auth(token));
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        suggestions: [
          {
            plan_set_id: target.id,
            weight_kg: '102.50',
            source_set_log_id: expectedId,
            source_logged_date: '2026-11-03',
          },
        ],
      });
    }
  });
});

it('restricts suggestions to the student and accepted coach, and returns no unmatched targets', async () => {
  const ctx = await makeContext();
  const plan = await createPublishedPlan(ctx);
  const endpoint = `/students/${ids.trainee}/plan-days/${plan.dayId}/weight-suggestions`;
  await ctx.db
    .updateTable('bind_requests')
    .set({ status: 'ended' })
    .where('coach_id', '=', ids.otherCoach)
    .execute();
  for (const token of [ctx.otherStudentToken, ctx.otherCoachToken]) {
    const response = await request(ctx.app).get(endpoint).set(auth(token));
    expect(response.status).toBe(403);
  }
  const response = await request(ctx.app).get(endpoint).set(auth(ctx.traineeToken));
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ suggestions: [] });
  const wrongOwner = await request(ctx.app)
    .get(`/students/${ids.otherStudent}/plan-days/${plan.dayId}/weight-suggestions`)
    .set(auth(ctx.otherStudentToken));
  expect(wrongOwner.status).toBe(404);
});

it('uses the student gym-day and canonical RPE instead of legacy projections or explicit loads', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-10T19:59:00Z')); // Shanghai Nov 11 03:59: gym-day Nov 10.
  const ctx = await makeContext();
  const target = await createPublishedPlan(ctx);
  const history = await createPublishedPlan(ctx);
  await ctx.db
    .updateTable('plan_sets')
    .set({ load_mode: 'rpe', target_rpe: '8.5', intensity_mode: 'rpe', target_value: '8.5' })
    .where('plan_exercise_id', '=', target.planExerciseId)
    .execute();
  const log = await ctx.db
    .insertInto('set_logs')
    .values({
      student_id: ids.trainee,
      exercise_id: ids.exercise,
      plan_exercise_id: history.planExerciseId,
      set_index: 0,
      weight_kg: '105',
      reps: 5,
      rpe: '8.5',
      completed: true,
      failed: false,
      assumed: false,
      adhoc: false,
      logged_date: '2026-11-10',
      logged_at: new Date('2026-11-10T10:00:00Z'),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const get = () =>
    request(ctx.app)
      .get(`/students/${ids.trainee}/plan-days/${target.dayId}/weight-suggestions`)
      .set(auth(ctx.traineeToken));
  expect((await get()).body).toEqual({ suggestions: [] });
  vi.setSystemTime(new Date('2026-11-10T20:00:00Z')); // 04:00 cutoff.
  expect((await get()).body.suggestions).toEqual([
    expect.objectContaining({ source_set_log_id: log.id, weight_kg: '105.00' }),
  ]);
  await ctx.db
    .updateTable('plan_sets')
    .set({ target_weight: '100' })
    .where('plan_exercise_id', '=', target.planExerciseId)
    .execute();
  expect((await get()).body).toEqual({ suggestions: [] });
  await ctx.db
    .updateTable('plan_sets')
    .set({ load_mode: 'bodyweight', target_weight: null, target_rpe: null })
    .where('plan_exercise_id', '=', target.planExerciseId)
    .execute();
  expect((await get()).body).toEqual({ suggestions: [] });
  for (const load_mode of ['free_weight', 'bodyweight'] as const) {
    await ctx.db
      .updateTable('plan_sets')
      .set({ load_mode, target_rpe: '8.5' })
      .where('plan_exercise_id', '=', target.planExerciseId)
      .execute();
    expect((await get()).body.suggestions).toEqual([
      expect.objectContaining({ source_set_log_id: log.id, weight_kg: '105.00' }),
    ]);
  }
});
