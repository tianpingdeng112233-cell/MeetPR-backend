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
        exercise_id: ids.exercise,
        logged_date: '2026-05-15',
        set_index: 1,
        weight_kg: '100.00',
        reps: 5,
        rpe: '8.0',
        completed: true,
        failed: true,
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
        exercise_id: ids.exercise,
        logged_date: '2026-05-15',
        adhoc: false,
        weight_kg: '100.00',
        rpe: '8.0',
        completed: true,
        failed: true,
      }),
    ]);
  });

  it('returns adhoc rows with exercise identity for the owner', async () => {
    const ctx = await makeContext();
    await ctx.db
      .insertInto('set_logs')
      .values({
        student_id: ids.selfTrainStudent,
        plan_exercise_id: null,
        exercise_id: ids.exercise,
        logged_date: '2026-05-15',
        adhoc: true,
        set_index: 0,
        weight_kg: '140.00',
        reps: 5,
        rpe: '8.5',
        completed: true,
        logged_at: new Date('2026-05-15T12:00:00.000Z'),
      })
      .execute();

    const res = await request(ctx.app)
      .get(`/students/${ids.selfTrainStudent}/sets?from=2026-05-15&to=2026-05-16`)
      .set(auth(ctx.selfTrainStudentToken));

    expect(res.status).toBe(200);
    expect(res.body.logs).toEqual([
      expect.objectContaining({
        plan_exercise_id: null,
        exercise_id: ids.exercise,
        logged_date: '2026-05-15',
        adhoc: true,
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
          exercise_id: ids.exercise,
          logged_date: '2026-05-15',
          set_index: 1,
          weight_kg: '100.00',
          reps: 5,
          rpe: null,
          completed: true,
          failed: true,
          logged_at: new Date('2026-05-15T12:00:00.000Z'),
        },
        {
          student_id: ids.trainee,
          plan_exercise_id: otherCoachPlan.planExerciseId,
          exercise_id: ids.exercise,
          logged_date: '2026-05-15',
          set_index: 1,
          weight_kg: '110.00',
          reps: 3,
          rpe: null,
          completed: true,
          failed: false,
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
    expect(res.body.logs[0].failed).toBe(true);
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
