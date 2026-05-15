import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { auth, createPublishedPlan, ids, makeContext } from '../helpers/studentActions';

describe('student action DTO snake_case wire shape', () => {
  it('rejects camelCase set-log request fields and emits snake_case set responses', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);

    const camel = await request(ctx.app).post('/sets/log').set(auth(ctx.traineeToken)).send({
      planExerciseId: plan.planExerciseId,
      setIndex: 1,
      weightKg: '100.00',
      reps: 5,
      completed: true,
    });
    const snake = await request(ctx.app).post('/sets/log').set(auth(ctx.traineeToken)).send({
      plan_exercise_id: plan.planExerciseId,
      set_index: 1,
      weight_kg: '100.00',
      reps: 5,
      completed: true,
    });
    const fetched = await request(ctx.app)
      .get(`/students/${ids.trainee}/sets?from=2026-05-15&to=2099-01-01`)
      .set(auth(ctx.traineeToken));

    expect(camel.status).toBe(400);
    expect(camel.body.error).toBe('VALIDATION_ERROR');
    expect(snake.status).toBe(201);
    expect(fetched.status).toBe(200);
    expect(fetched.body.logs[0]).toHaveProperty('plan_exercise_id');
    expect(fetched.body.logs[0]).toHaveProperty('weight_kg');
    expect(fetched.body.logs[0]).not.toHaveProperty('planExerciseId');
    expect(fetched.body.logs[0]).not.toHaveProperty('weightKg');
  });

  it('rejects camelCase feedback request fields and emits snake_case feedback responses', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);

    const camel = await request(ctx.app).post('/coach/feedback').set(auth(ctx.coachToken)).send({
      studentId: ids.trainee,
      dayDate: '2026-05-15',
      planExerciseId: plan.planExerciseId,
      text: 'Good',
    });
    const snake = await request(ctx.app).post('/coach/feedback').set(auth(ctx.coachToken)).send({
      student_id: ids.trainee,
      day_date: '2026-05-15',
      plan_exercise_id: plan.planExerciseId,
      text: 'Good',
    });

    expect(camel.status).toBe(400);
    expect(camel.body.error).toBe('VALIDATION_ERROR');
    expect(snake.status).toBe(201);
    expect(snake.body).toHaveProperty('student_id');
    expect(snake.body).toHaveProperty('day_date');
    expect(snake.body).toHaveProperty('plan_exercise_id');
    expect(snake.body).toHaveProperty('read_at');
    expect(snake.body).not.toHaveProperty('studentId');
    expect(snake.body).not.toHaveProperty('planExerciseId');
  });
});
