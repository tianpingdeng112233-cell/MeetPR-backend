import { describe, expect, it } from 'vitest';
import { request } from './helpers/inMemoryRequest';
import { auth, createPublishedPlan, ids, makeContext } from './helpers/studentActions';

describe('accessory actual RIR logging', () => {
  it('round-trips actual RIR without inventing RPE, and keeps it on legacy empty-RPE updates', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await ctx.db
      .updateTable('exercises')
      .set({ exercise_type: 'accessory' })
      .where('id', '=', ids.exercise)
      .execute();
    const body = {
      plan_exercise_id: plan.planExerciseId,
      set_index: 0,
      weight_kg: '20',
      reps: 10,
      rpe: null,
      actual_rir: 2,
      completed: true,
      logged_date: '2026-10-30',
    };
    expect(
      (await request(ctx.app).post('/sets/log').set(auth(ctx.traineeToken)).send(body)).status,
    ).toBe(201);
    for (const token of [ctx.traineeToken, ctx.coachToken]) {
      const read = await request(ctx.app)
        .get(`/students/${ids.trainee}/sets?from=2026-10-30&to=2026-10-31`)
        .set(auth(token));
      expect(read.status).toBe(200);
      expect(read.body.logs[0]).toMatchObject({ actual_rir: 2, rpe: null, weight_kg: '20.00' });
    }
    const { actual_rir: _ignored, ...legacy } = body;
    expect(
      (
        await request(ctx.app)
          .post('/sets/log')
          .set(auth(ctx.traineeToken))
          .send({ ...legacy, weight_kg: '25' })
      ).status,
    ).toBe(201);
    expect(
      (
        await request(ctx.app)
          .get(`/students/${ids.trainee}/sets?from=2026-10-30&to=2026-10-31`)
          .set(auth(ctx.traineeToken))
      ).body.logs[0],
    ).toMatchObject({ rpe: null, actual_rir: 2 });
    expect(
      (
        await request(ctx.app)
          .post('/sets/log')
          .set(auth(ctx.traineeToken))
          .send({ ...body, actual_rir: null, rpe: '8' })
      ).status,
    ).toBe(201);
    expect(
      (
        await request(ctx.app)
          .get(`/students/${ids.trainee}/sets?from=2026-10-30&to=2026-10-31`)
          .set(auth(ctx.traineeToken))
      ).body.logs[0],
    ).toMatchObject({ actual_rir: null });
  });

  it('keeps RIR zero for student-added records and supports explicitly clearing it', async () => {
    const ctx = await makeContext();
    await ctx.db
      .updateTable('exercises')
      .set({ exercise_type: 'accessory' })
      .where('id', '=', ids.exercise)
      .execute();
    const body = {
      exercise_id: ids.exercise,
      logged_date: '2026-10-30',
      set_index: 0,
      weight_kg: '0',
      reps: 10,
      rpe: null,
      actual_rir: 0,
      completed: true,
    };
    expect(
      (await request(ctx.app).post('/sets/log').set(auth(ctx.traineeToken)).send(body)).status,
    ).toBe(201);
    const read = async (): Promise<unknown> =>
      (
        await request(ctx.app)
          .get(`/students/${ids.trainee}/sets?from=2026-10-30&to=2026-10-31&scope=all`)
          .set(auth(ctx.traineeToken))
      ).body.logs[0];
    expect(await read()).toMatchObject({ actual_rir: 0, rpe: null });
    expect(
      (
        await request(ctx.app)
          .post('/sets/log')
          .set(auth(ctx.traineeToken))
          .send({ ...body, actual_rir: null })
      ).status,
    ).toBe(201);
    expect(await read()).toMatchObject({ actual_rir: null, rpe: null });
  });

  it('rejects RIR for main lifts and invalid or conflicting effort values', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    const body = {
      plan_exercise_id: plan.planExerciseId,
      set_index: 0,
      weight_kg: '20',
      reps: 10,
      completed: true,
      actual_rir: 2,
    };
    const main = await request(ctx.app).post('/sets/log').set(auth(ctx.traineeToken)).send(body);
    expect(main.status).toBe(400);
    expect(main.body.error).toBe('SETS_RIR_ACCESSORY_ONLY');
    await ctx.db
      .updateTable('exercises')
      .set({ exercise_type: 'accessory' })
      .where('id', '=', ids.exercise)
      .execute();
    for (const patch of [
      { actual_rir: -1 },
      { actual_rir: 10 },
      { actual_rir: 1.5 },
      { rpe: '8' },
    ]) {
      expect(
        (
          await request(ctx.app)
            .post('/sets/log')
            .set(auth(ctx.traineeToken))
            .send({ ...body, ...patch })
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await request(ctx.app)
          .post('/sets/log')
          .set(auth(ctx.traineeToken))
          .send({ ...body, actual_rir: 0 })
      ).status,
    ).toBe(201);
  });
});
