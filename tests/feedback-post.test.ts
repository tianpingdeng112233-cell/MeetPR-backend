import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { auth, createPublishedPlan, ids, makeContext } from './helpers/studentActions';

describe('POST /coach/feedback', () => {
  it('creates trimmed feedback for an owned published plan exercise', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);

    const res = await request(ctx.app).post('/coach/feedback').set(auth(ctx.coachToken)).send({
      student_id: ids.trainee,
      day_date: '2026-05-15',
      plan_exercise_id: plan.planExerciseId,
      text: '  Strong top set  ',
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: expect.any(String),
      coach_id: ids.coach,
      student_id: ids.trainee,
      day_date: '2026-05-15',
      plan_exercise_id: plan.planExerciseId,
      text: 'Strong top set',
      read_at: null,
    });
  });

  it('allows optional day_date and plan_exercise_id with coarse coach ownership', async () => {
    const ctx = await makeContext();
    await createPublishedPlan(ctx);

    const res = await request(ctx.app).post('/coach/feedback').set(auth(ctx.coachToken)).send({
      student_id: ids.trainee,
      text: 'Good session',
    });

    expect(res.status).toBe(201);
    expect(res.body.day_date).toBeNull();
    expect(res.body.plan_exercise_id).toBeNull();
  });

  it('rejects non-coach and plan exercises owned by another coach', async () => {
    const ctx = await makeContext();
    const otherPlan = await createPublishedPlan(ctx, ids.otherCoach, ids.trainee);

    const asStudent = await request(ctx.app)
      .post('/coach/feedback')
      .set(auth(ctx.traineeToken))
      .send({ student_id: ids.trainee, text: 'Nope' });
    const wrongCoachExercise = await request(ctx.app)
      .post('/coach/feedback')
      .set(auth(ctx.coachToken))
      .send({
        student_id: ids.trainee,
        plan_exercise_id: otherPlan.planExerciseId,
        text: 'No cross-coach writes',
      });

    expect(asStudent.status).toBe(403);
    expect(wrongCoachExercise.status).toBe(400);
    expect(wrongCoachExercise.body).toEqual({ error: 'FEEDBACK_PLAN_EXERCISE_NOT_OWNED' });
  });
});
