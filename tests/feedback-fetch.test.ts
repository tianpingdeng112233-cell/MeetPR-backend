import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { auth, createPublishedPlan, ids, makeContext } from './helpers/studentActions';

describe('GET /students/:id/feedback', () => {
  it('returns all own feedback ordered by posted_at descending', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await ctx.db
      .insertInto('feedback')
      .values([
        {
          coach_id: ids.coach,
          student_id: ids.trainee,
          day_date: '2026-05-14',
          plan_exercise_id: plan.planExerciseId,
          text: 'Earlier',
          posted_at: new Date('2026-05-14T12:00:00.000Z'),
        },
        {
          coach_id: ids.otherCoach,
          student_id: ids.trainee,
          day_date: '2026-05-15',
          plan_exercise_id: null,
          text: 'Later',
          posted_at: new Date('2026-05-15T12:00:00.000Z'),
        },
      ])
      .execute();

    const res = await request(ctx.app)
      .get(`/students/${ids.trainee}/feedback`)
      .set(auth(ctx.traineeToken));

    expect(res.status).toBe(200);
    expect(res.body.items.map((item: { text: string }) => item.text)).toEqual(['Later', 'Earlier']);
  });

  it('lets a coach see only feedback that coach wrote', async () => {
    const ctx = await makeContext();
    await createPublishedPlan(ctx);
    await ctx.db
      .insertInto('feedback')
      .values([
        {
          coach_id: ids.coach,
          student_id: ids.trainee,
          day_date: null,
          plan_exercise_id: null,
          text: 'Coach A feedback',
        },
        {
          coach_id: ids.otherCoach,
          student_id: ids.trainee,
          day_date: null,
          plan_exercise_id: null,
          text: 'Coach B feedback',
        },
      ])
      .execute();

    const res = await request(ctx.app)
      .get(`/students/${ids.trainee}/feedback`)
      .set(auth(ctx.coachToken));

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].text).toBe('Coach A feedback');
  });

  it('returns empty list for coaches with no feedback and forbids non-self student access', async () => {
    const ctx = await makeContext();

    const asCoach = await request(ctx.app)
      .get(`/students/${ids.otherStudent}/feedback`)
      .set(auth(ctx.coachToken));
    const asStudent = await request(ctx.app)
      .get(`/students/${ids.otherStudent}/feedback`)
      .set(auth(ctx.traineeToken));

    expect(asCoach.status).toBe(200);
    expect(asCoach.body).toEqual({ items: [] });
    expect(asStudent.status).toBe(403);
  });
});
