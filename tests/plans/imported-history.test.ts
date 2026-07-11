import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { auth, createPublishedPlan, ids, makeContext } from '../helpers/studentActions';

function dateText(value: unknown): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
}

describe('POST /plans/:id/imported-history', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('requires confirmation and reports idempotent created/existing counts', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await ctx.db
      .updateTable('plans')
      .set({ start_date: '2000-01-03', end_date: '2000-01-30' })
      .where('id', '=', plan.planId)
      .execute();

    const missingConfirmation = await request(ctx.app)
      .post(`/plans/${plan.planId}/imported-history`)
      .set(auth(ctx.coachToken))
      .send({ confirm: false });
    expect(missingConfirmation.status).toBe(400);
    expect(await ctx.db.selectFrom('set_logs').selectAll().execute()).toEqual([]);

    const imported = await request(ctx.app)
      .post(`/plans/${plan.planId}/imported-history`)
      .set(auth(ctx.coachToken))
      .send({ confirm: true });
    expect(imported.status).toBe(200);
    expect(imported.body).toEqual({
      plan_id: plan.planId,
      created_set_logs: 1,
      existing_set_logs: 0,
      assumed: true,
    });

    const assumed = await ctx.db.selectFrom('set_logs').selectAll().executeTakeFirstOrThrow();
    expect(assumed).toMatchObject({
      student_id: ids.trainee,
      plan_exercise_id: plan.planExerciseId,
      exercise_id: ids.exercise,
      set_index: 0,
      reps: 5,
      completed: true,
      failed: false,
      assumed: true,
      adhoc: false,
    });
    expect(Number(assumed.weight_kg)).toBe(100);
    expect(dateText(assumed.logged_date)).toBe('2000-01-03');
    expect(assumed.logged_at.toISOString()).toBe('2000-01-03T12:00:00.000Z');

    const repeated = await request(ctx.app)
      .post(`/plans/${plan.planId}/imported-history`)
      .set(auth(ctx.traineeToken))
      .send({ confirm: true });
    expect(repeated.status).toBe(200);
    expect(repeated.body).toEqual({
      plan_id: plan.planId,
      created_set_logs: 0,
      existing_set_logs: 1,
      assumed: true,
    });
  });

  it('imports only planned dates strictly before today', async () => {
    // Fake only Date — freezing setTimeout would hang supertest's async I/O.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-10T08:00:00.000Z'));

    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await ctx.db
      .updateTable('plans')
      .set({ start_date: '2026-07-06', end_date: '2026-07-19' })
      .where('id', '=', plan.planId)
      .execute();

    for (const [dayOfWeek, sortOrder] of [
      [5, 1],
      [6, 2],
    ] as const) {
      const day = await ctx.db
        .insertInto('plan_days')
        .values({
          plan_id: plan.planId,
          day_of_week: dayOfWeek,
          week_number: 1,
          sort_order: sortOrder,
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

    const response = await request(ctx.app)
      .post(`/plans/${plan.planId}/imported-history`)
      .set(auth(ctx.traineeToken))
      .send({ confirm: true });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ created_set_logs: 1, existing_set_logs: 0 });
    const rows = await ctx.db.selectFrom('set_logs').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.plan_exercise_id).toBe(plan.planExerciseId);
    expect(dateText(rows[0]?.logged_date)).toBe('2026-07-06');
  });

  it('projects day_of_week positionally from a non-Monday start_date (start + dow - 1)', async () => {
    // Locks the positional (not ISO-weekday) semantics: with an ISO-weekday
    // anchor and a Wednesday start, day_of_week=3 would collapse onto the
    // start date (offset 0). Positional semantics put it two days later.
    // Fake only Date so every projected date sits strictly before "today".
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-20T08:00:00.000Z'));

    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    // 2026-07-08 is a Wednesday (2026-07-06 is a Monday).
    await ctx.db
      .updateTable('plans')
      .set({ start_date: '2026-07-08', end_date: '2026-07-21' })
      .where('id', '=', plan.planId)
      .execute();

    const day = await ctx.db
      .insertInto('plan_days')
      .values({ plan_id: plan.planId, day_of_week: 3, week_number: 1, sort_order: 1 })
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

    const response = await request(ctx.app)
      .post(`/plans/${plan.planId}/imported-history`)
      .set(auth(ctx.coachToken))
      .send({ confirm: true });
    expect(response.status).toBe(200);

    const wednesdayRow = await ctx.db
      .selectFrom('set_logs')
      .selectAll()
      .where('plan_exercise_id', '=', exercise.id)
      .executeTakeFirstOrThrow();
    // start (2026-07-08) + (dow 3 - 1) = 2026-07-10, NOT the start date itself.
    expect(dateText(wednesdayRow.logged_date)).toBe('2026-07-10');
  });

  it('maps RPE targets to zero weight and the prescribed RPE', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await ctx.db
      .updateTable('plans')
      .set({ start_date: '2000-01-03', end_date: '2000-01-30' })
      .where('id', '=', plan.planId)
      .execute();
    await ctx.db
      .updateTable('plan_sets')
      .set({ intensity_mode: 'rpe', target_value: '8.00' })
      .where('plan_exercise_id', '=', plan.planExerciseId)
      .execute();

    const response = await request(ctx.app)
      .post(`/plans/${plan.planId}/imported-history`)
      .set(auth(ctx.coachToken))
      .send({ confirm: true });

    expect(response.status).toBe(200);
    const assumed = await ctx.db.selectFrom('set_logs').selectAll().executeTakeFirstOrThrow();
    expect(Number(assumed.weight_kg)).toBe(0);
    expect(Number(assumed.rpe)).toBe(8);
    expect(assumed.assumed).toBe(true);
  });

  it('hides foreign plans and requires the owner coach to retain an accepted bond', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);

    const otherCoach = await request(ctx.app)
      .post(`/plans/${plan.planId}/imported-history`)
      .set(auth(ctx.otherCoachToken))
      .send({ confirm: true });
    const otherStudent = await request(ctx.app)
      .post(`/plans/${plan.planId}/imported-history`)
      .set(auth(ctx.otherStudentToken))
      .send({ confirm: true });

    expect(otherCoach.status).toBe(404);
    expect(otherCoach.body).toEqual({ error: 'PLAN_NOT_FOUND' });
    expect(otherStudent.status).toBe(404);
    expect(otherStudent.body).toEqual({ error: 'PLAN_NOT_FOUND' });

    await ctx.db
      .updateTable('bind_requests')
      .set({ status: 'cancelled' })
      .where('coach_id', '=', ids.coach)
      .where('student_id', '=', ids.trainee)
      .execute();
    const unboundOwner = await request(ctx.app)
      .post(`/plans/${plan.planId}/imported-history`)
      .set(auth(ctx.coachToken))
      .send({ confirm: true });

    expect(unboundOwner.status).toBe(403);
    expect(unboundOwner.body).toEqual({ error: 'BIND_NOT_ACCEPTED' });
  });
});

describe('plan tree mutability after imported history', () => {
  it('locks only the imported exercise, its day, and calendar metadata; additive writes and publish stay open', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await ctx.db
      .updateTable('plans')
      .set({ status: 'draft', start_date: '2000-01-03', end_date: '2000-01-30' })
      .where('id', '=', plan.planId)
      .execute();

    const imported = await request(ctx.app)
      .post(`/plans/${plan.planId}/imported-history`)
      .set(auth(ctx.coachToken))
      .send({ confirm: true });
    expect(imported.status).toBe(200);

    const day = await ctx.db
      .selectFrom('plan_days')
      .select('id')
      .where('plan_id', '=', plan.planId)
      .executeTakeFirstOrThrow();

    const addDay = await request(ctx.app)
      .post(`/plans/${plan.planId}/days`)
      .set(auth(ctx.coachToken))
      .send({ day_of_week: 6, week_number: 1, sort_order: 9 });
    expect(addDay.status).toBe(201);

    // Fill the new day so the publish completeness gate (422 on empty days /
    // zero-set exercises) stays satisfied — this also proves additive
    // exercise/set writes stay open on a history-locked plan.
    const addExercise = await request(ctx.app)
      .post(`/plans/days/${addDay.body.id as string}/exercises`)
      .set(auth(ctx.coachToken))
      .send({ exercise_id: ids.exercise, is_main_lift: false, sort_order: 0 });
    expect(addExercise.status).toBe(201);
    const addSet = await request(ctx.app)
      .post(`/plans/exercises/${addExercise.body.id as string}/sets`)
      .set(auth(ctx.coachToken))
      .send({
        set_number: 1,
        target_reps: 5,
        intensity_mode: 'weight',
        target_value: '60',
        set_type: 'working',
      });
    expect(addSet.status).toBe(201);

    const deleteDay = await request(ctx.app)
      .delete(`/plans/days/${day.id}`)
      .set(auth(ctx.coachToken));
    expect(deleteDay.status).toBe(409);
    expect(deleteDay.body).toEqual({
      error: 'DAY_HISTORY_IMMUTABLE',
      details: { day_id: day.id, exercise_ids: [plan.planExerciseId] },
    });

    const shiftDates = await request(ctx.app)
      .patch(`/plans/${plan.planId}`)
      .set(auth(ctx.coachToken))
      .send({ start_date: '2000-01-10' });
    expect(shiftDates.status).toBe(409);
    expect(shiftDates.body).toEqual({ error: 'PLAN_HISTORY_IMMUTABLE' });

    // Publishing the locked draft must still work — plan-web marks assumed
    // history on the draft and publishes right after.
    const publish = await request(ctx.app)
      .post(`/plans/${plan.planId}/publish`)
      .set(auth(ctx.coachToken));
    expect(publish.status).toBe(200);
  });

  it('a real logged set freezes its plan exercise', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await request(ctx.app).post('/sets/log').set(auth(ctx.traineeToken)).send({
      plan_exercise_id: plan.planExerciseId,
      set_index: 0,
      weight_kg: 100,
      reps: 5,
      completed: true,
    });

    const deleteExercise = await request(ctx.app)
      .delete(`/plans/exercises/${plan.planExerciseId}`)
      .set(auth(ctx.coachToken));
    expect(deleteExercise.status).toBe(409);
    expect(deleteExercise.body).toEqual({
      error: 'EXERCISE_HISTORY_IMMUTABLE',
      details: { exercise_ids: [plan.planExerciseId] },
    });
  });
});
