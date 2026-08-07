import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TestContext } from '../helpers/studentActions';
import { auth, createPublishedPlan, ids, makeContext } from '../helpers/studentActions';

async function addPlanDay(
  ctx: TestContext,
  planId: string,
  options: { dayOfWeek: number; weekNumber?: number; withSet?: boolean },
) {
  const day = await ctx.db
    .insertInto('plan_days')
    .values({
      plan_id: planId,
      day_of_week: options.dayOfWeek,
      week_number: options.weekNumber ?? 1,
      sort_order: 0,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const exercise = await ctx.db
    .insertInto('plan_exercises')
    .values({
      plan_day_id: day.id,
      exercise_id: ids.exercise,
      is_main_lift: true,
      sort_order: 0,
      notes: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  if (options.withSet !== false) {
    await ctx.db
      .insertInto('plan_sets')
      .values({
        plan_exercise_id: exercise.id,
        set_number: 1,
        target_reps: 5,
        target_reps_max: null,
        intensity_mode: 'weight',
        target_value: '100.00',
        set_type: 'working',
        rest_seconds: null,
      })
      .execute();
  }
  return { dayId: day.id, planExerciseId: exercise.id };
}

function coachedLog(planExerciseId: string, setIndex: number, overrides = {}) {
  return {
    plan_exercise_id: planExerciseId,
    set_index: setIndex,
    weight_kg: '100.00',
    reps: 5,
    completed: true,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('sequence progression auto completion', () => {
  it('completes a full prescribed day and counts a failed set as recorded', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);

    const response = await request(ctx.app)
      .post('/sets/log')
      .set(auth(ctx.traineeToken))
      .send(coachedLog(plan.planExerciseId, 0, { completed: false, failed: true }));
    const completion = await ctx.db
      .selectFrom('plan_day_completions')
      .selectAll()
      .executeTakeFirst();

    expect(response.status).toBe(201);
    expect(completion).toMatchObject({
      plan_day_id: plan.dayId,
      student_id: ids.trainee,
      source: 'auto',
    });
  });

  it('does not complete with one prescribed set missing or from adhoc logs', async () => {
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

    await request(ctx.app)
      .post('/sets/log')
      .set(auth(ctx.traineeToken))
      .send(coachedLog(plan.planExerciseId, 0));
    await request(ctx.app).post('/sets/log').set(auth(ctx.traineeToken)).send({
      exercise_id: ids.exercise,
      logged_date: '2026-08-07',
      set_index: 1,
      weight_kg: '100.00',
      reps: 5,
      completed: true,
    });
    expect(await ctx.db.selectFrom('plan_day_completions').selectAll().execute()).toHaveLength(0);

    await request(ctx.app)
      .post('/sets/log')
      .set(auth(ctx.traineeToken))
      .send(coachedLog(plan.planExerciseId, 1));
    expect(await ctx.db.selectFrom('plan_day_completions').selectAll().execute()).toHaveLength(1);
  });

  it('recreates auto completion when a withdrawn full day is logged again', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    const payload = coachedLog(plan.planExerciseId, 0);

    await request(ctx.app).post('/sets/log').set(auth(ctx.traineeToken)).send(payload);
    const deleted = await request(ctx.app)
      .delete(`/plans/days/${plan.dayId}/complete`)
      .set(auth(ctx.traineeToken));
    expect(deleted.status).toBe(204);
    expect(await ctx.db.selectFrom('plan_day_completions').selectAll().execute()).toHaveLength(0);

    await request(ctx.app).post('/sets/log').set(auth(ctx.traineeToken)).send(payload);
    const completion = await ctx.db
      .selectFrom('plan_day_completions')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(completion.source).toBe('auto');
  });
});

describe('sequence progression manual completion', () => {
  it('allows zero prescribed sets and returns the same completion idempotently', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await ctx.db
      .deleteFrom('plan_sets')
      .where('plan_exercise_id', '=', plan.planExerciseId)
      .execute();

    const first = await request(ctx.app)
      .post(`/plans/days/${plan.dayId}/complete`)
      .set(auth(ctx.traineeToken));
    const second = await request(ctx.app)
      .post(`/plans/days/${plan.dayId}/complete`)
      .set(auth(ctx.traineeToken));

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      plan_day_id: plan.dayId,
      student_id: ids.trainee,
      source: 'manual',
    });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(await ctx.db.selectFrom('plan_day_completions').selectAll().execute()).toHaveLength(1);
  });

  it('rejects another student and a non-published plan with the domain envelopes', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);

    const otherStudent = await request(ctx.app)
      .post(`/plans/days/${plan.dayId}/complete`)
      .set(auth(ctx.otherStudentToken));
    expect(otherStudent.status).toBe(403);
    expect(otherStudent.body).toEqual({ error: 'NOT_PLAN_STUDENT' });

    await ctx.db
      .updateTable('plans')
      .set({ status: 'draft' })
      .where('id', '=', plan.planId)
      .execute();
    const inactive = await request(ctx.app)
      .post(`/plans/days/${plan.dayId}/complete`)
      .set(auth(ctx.traineeToken));
    expect(inactive.status).toBe(409);
    expect(inactive.body).toEqual({ error: 'PLAN_NOT_ACTIVE' });
  });
});

describe('sequence progression completion undo', () => {
  it('only removes the latest completion in the target plan', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    const secondDay = await addPlanDay(ctx, plan.planId, { dayOfWeek: 2, withSet: false });
    await ctx.db
      .insertInto('plan_day_completions')
      .values([
        {
          plan_day_id: plan.dayId,
          student_id: ids.trainee,
          source: 'manual',
          completed_at: new Date(Date.now() - 60_000),
        },
        {
          plan_day_id: secondDay.dayId,
          student_id: ids.trainee,
          source: 'manual',
          completed_at: new Date(),
        },
      ])
      .execute();

    const older = await request(ctx.app)
      .delete(`/plans/days/${plan.dayId}/complete`)
      .set(auth(ctx.traineeToken));
    expect(older.status).toBe(409);
    expect(older.body).toEqual({ error: 'NOT_LATEST_COMPLETION' });

    const latest = await request(ctx.app)
      .delete(`/plans/days/${secondDay.dayId}/complete`)
      .set(auth(ctx.traineeToken));
    expect(latest.status).toBe(204);
  });

  it('returns NO_COMPLETION_TO_UNDO for an unfinished day', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);

    const response = await request(ctx.app)
      .delete(`/plans/days/${plan.dayId}/complete`)
      .set(auth(ctx.traineeToken));
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'NO_COMPLETION_TO_UNDO' });
  });

  it('uses the 04:00 Shanghai gym-day boundary for the undo window', async () => {
    const beforeCutoff = new Date('2026-07-12T19:59:00.000Z');

    const allowedCtx = await makeContext();
    const allowedPlan = await createPublishedPlan(allowedCtx);
    await allowedCtx.db
      .insertInto('plan_day_completions')
      .values({
        plan_day_id: allowedPlan.dayId,
        student_id: ids.trainee,
        source: 'manual',
        completed_at: beforeCutoff,
      })
      .execute();
    vi.useFakeTimers({ toFake: ['Date'], now: beforeCutoff });
    const allowed = await request(allowedCtx.app)
      .delete(`/plans/days/${allowedPlan.dayId}/complete`)
      .set(auth(allowedCtx.traineeToken));
    expect(allowed.status).toBe(204);

    vi.useRealTimers();
    const blockedCtx = await makeContext();
    const blockedPlan = await createPublishedPlan(blockedCtx);
    await blockedCtx.db
      .insertInto('plan_day_completions')
      .values({
        plan_day_id: blockedPlan.dayId,
        student_id: ids.trainee,
        source: 'manual',
        completed_at: beforeCutoff,
      })
      .execute();
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-07-12T20:00:00.000Z') });
    const blocked = await request(blockedCtx.app)
      .delete(`/plans/days/${blockedPlan.dayId}/complete`)
      .set(auth(blockedCtx.traineeToken));
    expect(blocked.status).toBe(409);
    expect(blocked.body).toEqual({ error: 'UNDO_WINDOW_PASSED' });
  });
});

describe('sequence progression backfill and serialization', () => {
  it('backfills old assumed days once and leaves the first unimported day incomplete', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-08-07T12:00:00.000Z') });
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await ctx.db
      .updateTable('plans')
      .set({ start_date: '2026-08-01', end_date: '2026-08-31' })
      .where('id', '=', plan.planId)
      .execute();
    const cursorDay = await addPlanDay(ctx, plan.planId, { dayOfWeek: 7 });

    const first = await request(ctx.app)
      .post(`/plans/${plan.planId}/imported-history`)
      .set(auth(ctx.coachToken))
      .send({ confirm: true });
    const second = await request(ctx.app)
      .post(`/plans/${plan.planId}/imported-history`)
      .set(auth(ctx.coachToken))
      .send({ confirm: true });
    const completions = await ctx.db.selectFrom('plan_day_completions').selectAll().execute();
    const detail = await request(ctx.app).get(`/plans/${plan.planId}`).set(auth(ctx.traineeToken));

    expect(first.status).toBe(200);
    expect(first.body.created_set_logs).toBe(1);
    expect(second.status).toBe(200);
    expect(second.body.created_set_logs).toBe(0);
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      plan_day_id: plan.dayId,
      source: 'backfill',
      completed_at: new Date('2026-08-01T00:00:00.000Z'),
    });
    expect(detail.body.days).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: plan.dayId,
          completed_at: '2026-08-01T00:00:00.000Z',
          completion_source: 'backfill',
        }),
        expect.objectContaining({
          id: cursorDay.dayId,
          completed_at: null,
          completion_source: null,
        }),
      ]),
    );
  });

  it('writes published_at on publish and paused-to-published transitions', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await ctx.db
      .updateTable('plans')
      .set({ status: 'draft', published_at: null })
      .where('id', '=', plan.planId)
      .execute();

    const published = await request(ctx.app)
      .post(`/plans/${plan.planId}/publish`)
      .set(auth(ctx.coachToken));
    expect(published.status).toBe(200);
    expect(published.body.published_at).toEqual(expect.any(String));

    await request(ctx.app)
      .patch(`/plans/${plan.planId}`)
      .set(auth(ctx.coachToken))
      .send({ status: 'paused' });
    await ctx.db
      .updateTable('plans')
      .set({ published_at: new Date('2000-01-01T00:00:00.000Z') })
      .where('id', '=', plan.planId)
      .execute();
    const republished = await request(ctx.app)
      .patch(`/plans/${plan.planId}`)
      .set(auth(ctx.coachToken))
      .send({ status: 'published' });
    const list = await request(ctx.app)
      .get(`/students/${ids.trainee}/plans`)
      .set(auth(ctx.coachToken));

    expect(republished.status).toBe(200);
    expect(republished.body.published_at).not.toBe('2000-01-01T00:00:00.000Z');
    expect(list.body.plans[0]).toMatchObject({
      id: plan.planId,
      published_at: republished.body.published_at,
    });
  });
});
