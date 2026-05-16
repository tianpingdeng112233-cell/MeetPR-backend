import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { auth, ids, makeContext } from './helpers/studentActions';

async function insertFeedback(
  ctx: Awaited<ReturnType<typeof makeContext>>,
  studentId = ids.trainee,
) {
  return ctx.db
    .insertInto('feedback')
    .values({
      coach_id: ids.coach,
      student_id: studentId,
      day_date: null,
      plan_exercise_id: null,
      text: 'Read this',
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();
}

describe('PATCH /feedback/:id/read', () => {
  it('allows coached_student self mark and is idempotent without overwriting read_at', async () => {
    const ctx = await makeContext();
    const feedback = await insertFeedback(ctx);

    const first = await request(ctx.app)
      .patch(`/feedback/${feedback.id}/read`)
      .set(auth(ctx.traineeToken));
    const afterFirst = await ctx.db
      .selectFrom('feedback')
      .select(['read_at'])
      .where('id', '=', feedback.id)
      .executeTakeFirstOrThrow();
    const second = await request(ctx.app)
      .patch(`/feedback/${feedback.id}/read`)
      .set(auth(ctx.traineeToken));
    const afterSecond = await ctx.db
      .selectFrom('feedback')
      .select(['read_at'])
      .where('id', '=', feedback.id)
      .executeTakeFirstOrThrow();

    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    expect(afterFirst.read_at).toBeInstanceOf(Date);
    expect(afterSecond.read_at?.toISOString()).toBe(afterFirst.read_at?.toISOString());
  });

  it('allows self_train_student self mark', async () => {
    const ctx = await makeContext();
    const feedback = await insertFeedback(ctx, ids.selfTrainStudent);

    const res = await request(ctx.app)
      .patch(`/feedback/${feedback.id}/read`)
      .set(auth(ctx.selfTrainStudentToken));

    expect(res.status).toBe(204);
  });

  it('rejects coach role and non-self students, and 404s missing feedback', async () => {
    const ctx = await makeContext();
    const feedback = await insertFeedback(ctx);

    const asCoach = await request(ctx.app)
      .patch(`/feedback/${feedback.id}/read`)
      .set(auth(ctx.coachToken));
    const wrongStudent = await request(ctx.app)
      .patch(`/feedback/${feedback.id}/read`)
      .set(auth(ctx.otherStudentToken));
    const missing = await request(ctx.app)
      .patch('/feedback/10000000-0000-4000-8000-000000009999/read')
      .set(auth(ctx.traineeToken));

    expect(asCoach.status).toBe(403);
    expect(wrongStudent.status).toBe(404);
    expect(missing.status).toBe(404);
  });
});
