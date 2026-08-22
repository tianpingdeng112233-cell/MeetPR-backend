import request from 'supertest';
import { describe, expect, it } from 'vitest';

import {
  auth,
  createPublishedPlan,
  ids,
  makeContext,
  type TestContext,
} from './helpers/studentActions';

const customExerciseBody = {
  name: 'Tempo Squat',
  exercise_type: 'main_lift_variation',
  main_lift_family: 'squat',
  is_competition_lift: false,
  muscle_groups: ['quad', 'glute'],
  equipment: ['barbell'],
  movement_pattern: [],
};

async function createCustomExercise(
  ctx: TestContext,
  token = ctx.coachToken,
): Promise<{ id: string }> {
  const response = await request(ctx.app)
    .post('/exercises')
    .set(auth(token))
    .send(customExerciseBody);

  expect(response.status).toBe(201);
  return response.body as { id: string };
}

describe('custom exercise CRUD', () => {
  it('POST /exercises stores trimmed name_en when supplied', async () => {
    const ctx = await makeContext();

    const response = await request(ctx.app)
      .post('/exercises')
      .set(auth(ctx.coachToken))
      .send({ ...customExerciseBody, name_en: '  Tempo Squat  ' });

    expect(response.status).toBe(201);
    expect(response.body.name_en).toBe('Tempo Squat');
    const stored = await ctx.db
      .selectFrom('exercises')
      .select('name_en')
      .where('id', '=', response.body.id as string)
      .executeTakeFirstOrThrow();
    expect(stored.name_en).toBe('Tempo Squat');
    await ctx.db.destroy();
  });

  it('POST /exercises keeps name_en null when omitted', async () => {
    const ctx = await makeContext();

    const response = await request(ctx.app)
      .post('/exercises')
      .set(auth(ctx.coachToken))
      .send(customExerciseBody);

    expect(response.status).toBe(201);
    expect(response.body.name_en).toBeNull();
    await ctx.db.destroy();
  });

  it('PATCH /exercises/:id partially updates an owned custom exercise', async () => {
    const ctx = await makeContext();
    const exercise = await createCustomExercise(ctx);

    const response = await request(ctx.app)
      .patch(`/exercises/${exercise.id}`)
      .set(auth(ctx.coachToken))
      .send({ name: '  Paused Tempo Squat  ', name_en: '  Pause Tempo Squat  ' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        id: exercise.id,
        name: 'Paused Tempo Squat',
        name_en: 'Pause Tempo Squat',
        exercise_type: 'main_lift_variation',
        main_lift_family: 'squat',
        muscle_groups: ['quad', 'glute'],
        equipment: ['barbell'],
      }),
    );
    await ctx.db.destroy();
  });

  it('PATCH /exercises/:id returns 404 for another coach and seed exercises', async () => {
    const ctx = await makeContext();
    const otherCoachExercise = await createCustomExercise(ctx, ctx.otherCoachToken);

    const otherCoachResponse = await request(ctx.app)
      .patch(`/exercises/${otherCoachExercise.id}`)
      .set(auth(ctx.coachToken))
      .send({ name: 'Hidden edit' });
    const seedResponse = await request(ctx.app)
      .patch(`/exercises/${ids.exercise}`)
      .set(auth(ctx.coachToken))
      .send({ name: 'Seed edit' });

    expect(otherCoachResponse.status).toBe(404);
    expect(otherCoachResponse.body).toEqual({ error: 'EXERCISE_NOT_FOUND' });
    expect(seedResponse.status).toBe(404);
    expect(seedResponse.body).toEqual({ error: 'EXERCISE_NOT_FOUND' });
    await ctx.db.destroy();
  });

  it('PATCH /exercises/:id clears name_en when explicitly set to null', async () => {
    const ctx = await makeContext();
    const created = await request(ctx.app)
      .post('/exercises')
      .set(auth(ctx.coachToken))
      .send({ ...customExerciseBody, name_en: 'Tempo Squat' });
    expect(created.status).toBe(201);

    const response = await request(ctx.app)
      .patch(`/exercises/${created.body.id as string}`)
      .set(auth(ctx.coachToken))
      .send({ name_en: null });

    expect(response.status).toBe(200);
    expect(response.body.name_en).toBeNull();
    const stored = await ctx.db
      .selectFrom('exercises')
      .select('name_en')
      .where('id', '=', created.body.id as string)
      .executeTakeFirstOrThrow();
    expect(stored.name_en).toBeNull();
    await ctx.db.destroy();
  });

  it('PATCH /exercises/:id accepts an atomic switch to accessory with null family', async () => {
    const ctx = await makeContext();
    const exercise = await createCustomExercise(ctx);

    const response = await request(ctx.app)
      .patch(`/exercises/${exercise.id}`)
      .set(auth(ctx.coachToken))
      .send({ exercise_type: 'accessory', main_lift_family: null });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ exercise_type: 'accessory', main_lift_family: null });
    await ctx.db.destroy();
  });

  it('PATCH and DELETE /exercises/:id return 404 for an unknown id', async () => {
    const ctx = await makeContext();
    const unknownId = '00000000-0000-4000-8000-000000000000';

    const patchResponse = await request(ctx.app)
      .patch(`/exercises/${unknownId}`)
      .set(auth(ctx.coachToken))
      .send({ name: 'Ghost' });
    const deleteResponse = await request(ctx.app)
      .delete(`/exercises/${unknownId}`)
      .set(auth(ctx.coachToken));

    expect(patchResponse.status).toBe(404);
    expect(patchResponse.body).toEqual({ error: 'EXERCISE_NOT_FOUND' });
    expect(deleteResponse.status).toBe(404);
    expect(deleteResponse.body).toEqual({ error: 'EXERCISE_NOT_FOUND' });
    await ctx.db.destroy();
  });

  it('PATCH /exercises/:id validates the merged final state', async () => {
    const ctx = await makeContext();
    const exercise = await createCustomExercise(ctx);

    const response = await request(ctx.app)
      .patch(`/exercises/${exercise.id}`)
      .set(auth(ctx.coachToken))
      .send({ exercise_type: 'accessory' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('VALIDATION_ERROR');
    expect(response.body.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['main_lift_family'] })]),
    );
    const stored = await ctx.db
      .selectFrom('exercises')
      .select(['exercise_type', 'main_lift_family'])
      .where('id', '=', exercise.id)
      .executeTakeFirstOrThrow();
    expect(stored).toEqual({
      exercise_type: 'main_lift_variation',
      main_lift_family: 'squat',
    });
    await ctx.db.destroy();
  });

  it('PATCH /exercises/:id rejects an empty body', async () => {
    const ctx = await makeContext();
    const exercise = await createCustomExercise(ctx);

    const response = await request(ctx.app)
      .patch(`/exercises/${exercise.id}`)
      .set(auth(ctx.coachToken))
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('VALIDATION_ERROR');
    await ctx.db.destroy();
  });

  it('DELETE /exercises/:id hard-deletes an unreferenced owned exercise', async () => {
    const ctx = await makeContext();
    const exercise = await createCustomExercise(ctx);

    const response = await request(ctx.app)
      .delete(`/exercises/${exercise.id}`)
      .set(auth(ctx.coachToken));

    expect(response.status).toBe(204);
    expect(
      await ctx.db
        .selectFrom('exercises')
        .select('id')
        .where('id', '=', exercise.id)
        .executeTakeFirst(),
    ).toBeUndefined();
    await ctx.db.destroy();
  });

  it('DELETE /exercises/:id returns plan usage with a distinct plan count', async () => {
    const ctx = await makeContext();
    const exercise = await createCustomExercise(ctx);
    const plan = await createPublishedPlan(ctx);
    await ctx.db
      .insertInto('plan_exercises')
      .values([
        {
          plan_day_id: plan.dayId,
          exercise_id: exercise.id,
          is_main_lift: false,
          sort_order: 1,
        },
        {
          plan_day_id: plan.dayId,
          exercise_id: exercise.id,
          is_main_lift: false,
          sort_order: 2,
        },
      ])
      .execute();

    const response = await request(ctx.app)
      .delete(`/exercises/${exercise.id}`)
      .set(auth(ctx.coachToken));

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: 'EXERCISE_IN_USE',
      plan_count: 1,
      log_count: 0,
    });
    await ctx.db.destroy();
  });

  it('DELETE /exercises/:id returns set log usage', async () => {
    const ctx = await makeContext();
    const exercise = await createCustomExercise(ctx);
    await ctx.db
      .insertInto('set_logs')
      .values({
        student_id: ids.trainee,
        plan_exercise_id: null,
        exercise_id: exercise.id,
        set_index: 1,
        weight_kg: '80',
        reps: 5,
        adhoc: true,
        logged_date: '2026-08-22',
      })
      .execute();

    const response = await request(ctx.app)
      .delete(`/exercises/${exercise.id}`)
      .set(auth(ctx.coachToken));

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: 'EXERCISE_IN_USE',
      plan_count: 0,
      log_count: 1,
    });
    await ctx.db.destroy();
  });

  it('DELETE /exercises/:id returns 404 for another coach and seed exercises', async () => {
    const ctx = await makeContext();
    const otherCoachExercise = await createCustomExercise(ctx, ctx.otherCoachToken);

    const otherCoachResponse = await request(ctx.app)
      .delete(`/exercises/${otherCoachExercise.id}`)
      .set(auth(ctx.coachToken));
    const seedResponse = await request(ctx.app)
      .delete(`/exercises/${ids.exercise}`)
      .set(auth(ctx.coachToken));

    expect(otherCoachResponse.status).toBe(404);
    expect(otherCoachResponse.body).toEqual({ error: 'EXERCISE_NOT_FOUND' });
    expect(seedResponse.status).toBe(404);
    expect(seedResponse.body).toEqual({ error: 'EXERCISE_NOT_FOUND' });
    await ctx.db.destroy();
  });
});
