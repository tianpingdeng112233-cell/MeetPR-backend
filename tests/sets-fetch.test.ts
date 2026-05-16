import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { auth, createPublishedPlan, ids, makeContext } from './helpers/studentActions';

describe('GET /students/:id/sets', () => {
  it('returns self set logs within the date range', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await ctx.db
      .insertInto('set_logs')
      .values({
        student_id: ids.trainee,
        plan_exercise_id: plan.planExerciseId,
        set_index: 1,
        weight_kg: '100.00',
        reps: 5,
        rpe: '8.0',
        completed: true,
        logged_at: new Date('2026-05-15T12:00:00.000Z'),
      })
      .execute();

    const res = await request(ctx.app)
      .get(`/students/${ids.trainee}/sets?from=2026-05-15&to=2026-05-16`)
      .set(auth(ctx.traineeToken));

    expect(res.status).toBe(200);
    expect(res.body.logs).toEqual([
      expect.objectContaining({
        student_id: ids.trainee,
        plan_exercise_id: plan.planExerciseId,
        weight_kg: '100.00',
        rpe: '8.0',
      }),
    ]);
  });

  it('lets an owning coach see only logs from that coach published plans', async () => {
    const ctx = await makeContext();
    const coachPlan = await createPublishedPlan(ctx, ids.coach, ids.trainee);
    const otherCoachPlan = await createPublishedPlan(ctx, ids.otherCoach, ids.trainee);
    await ctx.db
      .insertInto('set_logs')
      .values([
        {
          student_id: ids.trainee,
          plan_exercise_id: coachPlan.planExerciseId,
          set_index: 1,
          weight_kg: '100.00',
          reps: 5,
          rpe: null,
          completed: true,
          logged_at: new Date('2026-05-15T12:00:00.000Z'),
        },
        {
          student_id: ids.trainee,
          plan_exercise_id: otherCoachPlan.planExerciseId,
          set_index: 1,
          weight_kg: '110.00',
          reps: 3,
          rpe: null,
          completed: true,
          logged_at: new Date('2026-05-15T13:00:00.000Z'),
        },
      ])
      .execute();

    const res = await request(ctx.app)
      .get(`/students/${ids.trainee}/sets?from=2026-05-15&to=2026-05-16`)
      .set(auth(ctx.coachToken));

    expect(res.status).toBe(200);
    expect(res.body.logs).toHaveLength(1);
    expect(res.body.logs[0].plan_exercise_id).toBe(coachPlan.planExerciseId);
  });

  it('returns an empty list for a non-owner coach and forbids other students', async () => {
    const ctx = await makeContext();
    await createPublishedPlan(ctx, ids.coach, ids.otherStudent);

    const asCoach = await request(ctx.app)
      .get(`/students/${ids.otherStudent}/sets?from=2026-05-15&to=2026-05-16`)
      .set(auth(ctx.otherCoachToken));
    const asStudent = await request(ctx.app)
      .get(`/students/${ids.otherStudent}/sets?from=2026-05-15&to=2026-05-16`)
      .set(auth(ctx.traineeToken));

    expect(asCoach.status).toBe(200);
    expect(asCoach.body).toEqual({ logs: [] });
    expect(asStudent.status).toBe(403);
  });
});
