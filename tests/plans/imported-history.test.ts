import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { auth, createPublishedPlan, ids, makeContext } from '../helpers/studentActions';

describe('POST /plans/:id/imported-history', () => {
  it('requires explicit confirmation, is idempotent, and preserves a later real log', async () => {
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
      set_index: 0,
      weight_kg: expect.anything(),
      reps: 5,
      completed: true,
      failed: false,
      assumed: true,
    });
    expect(Number(assumed.weight_kg)).toBe(100);
    expect(assumed.logged_at.toISOString()).toContain('2000-01-03T12:00:00.000Z');

    const repeated = await request(ctx.app)
      .post(`/plans/${plan.planId}/imported-history`)
      .set(auth(ctx.traineeToken))
      .send({ confirm: true });
    expect(repeated.status).toBe(200);
    expect(repeated.body).toMatchObject({
      created_set_logs: 0,
      existing_set_logs: 1,
      assumed: true,
    });

    const actual = await request(ctx.app).post('/sets/log').set(auth(ctx.traineeToken)).send({
      plan_exercise_id: plan.planExerciseId,
      set_index: 0,
      weight_kg: '105.00',
      reps: 6,
      rpe: '8.0',
      completed: true,
    });
    expect(actual.status).toBe(201);

    const logged = await ctx.db.selectFrom('set_logs').selectAll().executeTakeFirstOrThrow();
    expect(logged.assumed).toBe(false);
    expect(Number(logged.weight_kg)).toBe(105);
    expect(logged.reps).toBe(6);
  });

  it('maps RPE-only historical sets to zero weight and locks every draft tree write after import', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await ctx.db
      .updateTable('plans')
      .set({ status: 'draft', start_date: '2000-01-03', end_date: '2000-01-30' })
      .where('id', '=', plan.planId)
      .execute();
    await ctx.db
      .updateTable('plan_sets')
      .set({ intensity_mode: 'rpe', target_value: '8.00' })
      .where('plan_exercise_id', '=', plan.planExerciseId)
      .execute();

    const imported = await request(ctx.app)
      .post(`/plans/${plan.planId}/imported-history`)
      .set(auth(ctx.coachToken))
      .send({ confirm: true });
    expect(imported.status).toBe(200);

    const assumed = await ctx.db.selectFrom('set_logs').selectAll().executeTakeFirstOrThrow();
    expect(Number(assumed.weight_kg)).toBe(0);
    expect(Number(assumed.rpe)).toBe(8);
    expect(assumed.assumed).toBe(true);

    const planSet = await ctx.db
      .selectFrom('plan_sets')
      .select(['id'])
      .where('plan_exercise_id', '=', plan.planExerciseId)
      .executeTakeFirstOrThrow();

    const mutations = await Promise.all([
      request(ctx.app)
        .patch(`/plans/${plan.planId}`)
        .set(auth(ctx.coachToken))
        .send({ start_date: '2000-01-10' }),
      request(ctx.app)
        .post(`/plans/${plan.planId}/days`)
        .set(auth(ctx.coachToken))
        .send({ day_of_week: 2, week_number: 1, sort_order: 1 }),
      request(ctx.app)
        .patch(`/plans/days/${plan.dayId}`)
        .set(auth(ctx.coachToken))
        .send({ sort_order: 1 }),
      request(ctx.app).delete(`/plans/days/${plan.dayId}`).set(auth(ctx.coachToken)),
      request(ctx.app)
        .post(`/plans/days/${plan.dayId}/exercises`)
        .set(auth(ctx.coachToken))
        .send({ exercise_id: ids.exercise, is_main_lift: false, sort_order: 1 }),
      request(ctx.app)
        .patch(`/plans/exercises/${plan.planExerciseId}`)
        .set(auth(ctx.coachToken))
        .send({ sort_order: 1 }),
      request(ctx.app).delete(`/plans/exercises/${plan.planExerciseId}`).set(auth(ctx.coachToken)),
      request(ctx.app)
        .post(`/plans/exercises/${plan.planExerciseId}/sets`)
        .set(auth(ctx.coachToken))
        .send({
          set_number: 2,
          target_reps: 5,
          intensity_mode: 'weight',
          target_value: '100.00',
          set_type: 'working',
        }),
      request(ctx.app)
        .patch(`/plans/sets/${planSet.id}`)
        .set(auth(ctx.coachToken))
        .send({ target_reps: 6 }),
      request(ctx.app).delete(`/plans/sets/${planSet.id}`).set(auth(ctx.coachToken)),
    ]);

    for (const mutation of mutations) {
      expect(mutation.status).toBe(409);
      expect(mutation.body).toEqual({ error: 'PLAN_HISTORY_IMMUTABLE' });
    }
  });

  it('does not let a non-owner coach create assumptions', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);

    const response = await request(ctx.app)
      .post(`/plans/${plan.planId}/imported-history`)
      .set(auth(ctx.otherCoachToken))
      .send({ confirm: true });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'PLAN_NOT_FOUND' });
  });
});
