import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { auth, createPublishedPlan, ids, makeContext } from './helpers/studentActions';

describe('POST /sets/log', () => {
  it('logs a set for a published plan exercise owned by the student', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);

    const res = await request(ctx.app).post('/sets/log').set(auth(ctx.traineeToken)).send({
      plan_exercise_id: plan.planExerciseId,
      set_index: 1,
      weight_kg: '100.00',
      reps: 5,
      rpe: '8.0',
      completed: true,
    });
    const rows = await ctx.db.selectFrom('set_logs').selectAll().execute();

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(String), logged_at: expect.any(String) });
    expect(rows[0]?.failed).toBe(false);
  });

  it('upserts by student, plan_exercise_id, and set_index and overwrites failed', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    const payload = {
      plan_exercise_id: plan.planExerciseId,
      set_index: 1,
      weight_kg: '100.00',
      reps: 5,
      rpe: null,
      completed: true,
      failed: true,
    };

    const first = await request(ctx.app)
      .post('/sets/log')
      .set(auth(ctx.traineeToken))
      .send(payload);
    const second = await request(ctx.app)
      .post('/sets/log')
      .set(auth(ctx.traineeToken))
      .send({ ...payload, weight_kg: '102.50', reps: 6, failed: false });

    const rows = await ctx.db.selectFrom('set_logs').selectAll().execute();
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.weight_kg)).toBe(102.5);
    expect(rows[0]?.reps).toBe(6);
    expect(rows[0]?.failed).toBe(false);
  });

  it('rejects coach role and unpublished or other-student plan exercises', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx, ids.coach, ids.otherStudent);
    const payload = {
      plan_exercise_id: plan.planExerciseId,
      set_index: 0,
      weight_kg: '90.00',
      reps: 5,
      completed: true,
    };

    const asCoach = await request(ctx.app)
      .post('/sets/log')
      .set(auth(ctx.coachToken))
      .send(payload);
    const wrongStudent = await request(ctx.app)
      .post('/sets/log')
      .set(auth(ctx.traineeToken))
      .send(payload);

    expect(asCoach.status).toBe(403);
    expect(wrongStudent.status).toBe(400);
    expect(wrongStudent.body).toEqual({ error: 'SETS_PLAN_EXERCISE_NOT_PUBLISHED' });
  });
});
