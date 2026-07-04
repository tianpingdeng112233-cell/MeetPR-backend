import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { auth, ids, makeContext } from './helpers/studentActions';

// Spec 012: session reviews — one row per training day, rewrite overwrites;
// readable by self and the bonded coach only.

describe('PUT /students/me/reviews/:date', () => {
  it('upserts by day and overwrites on rewrite', async () => {
    const ctx = await makeContext();

    const first = await request(ctx.app)
      .put('/students/me/reviews/2026-07-04')
      .set(auth(ctx.selfTrainStudentToken))
      .send({ feeling: '最后一组硬拉很稳', session_rpe: 8 });
    const second = await request(ctx.app)
      .put('/students/me/reviews/2026-07-04')
      .set(auth(ctx.selfTrainStudentToken))
      .send({ feeling: '改主意了,其实一般', session_rpe: 8.5 });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.feeling).toBe('改主意了,其实一般');
    expect(second.body.session_rpe).toBe('8.5');
    expect(second.body.review_date).toBe('2026-07-04');
  });

  it('rejects blank feelings and coach role', async () => {
    const ctx = await makeContext();

    const blank = await request(ctx.app)
      .put('/students/me/reviews/2026-07-04')
      .set(auth(ctx.traineeToken))
      .send({ feeling: '   ' });
    const asCoach = await request(ctx.app)
      .put('/students/me/reviews/2026-07-04')
      .set(auth(ctx.coachToken))
      .send({ feeling: '教练不该能写' });

    expect(blank.status).toBe(400);
    expect(blank.body).toEqual({ error: 'REVIEWS_FEELING_REQUIRED' });
    expect(asCoach.status).toBe(403);
  });
});

describe('GET /students/:id/reviews', () => {
  it('returns own reviews in the window; bonded coach can read; others cannot', async () => {
    const ctx = await makeContext();
    await request(ctx.app)
      .put('/students/me/reviews/2026-07-04')
      .set(auth(ctx.traineeToken))
      .send({ feeling: '今天顶到 RPE9 了' });

    const own = await request(ctx.app)
      .get(`/students/${ids.trainee}/reviews?from=2026-07-01&to=2026-07-31`)
      .set(auth(ctx.traineeToken));
    const bondedCoach = await request(ctx.app)
      .get(`/students/${ids.trainee}/reviews?from=2026-07-01&to=2026-07-31`)
      .set(auth(ctx.coachToken));
    const otherStudent = await request(ctx.app)
      .get(`/students/${ids.trainee}/reviews?from=2026-07-01&to=2026-07-31`)
      .set(auth(ctx.otherStudentToken));

    expect(own.status).toBe(200);
    expect(own.body.reviews).toHaveLength(1);
    expect(own.body.reviews[0].feeling).toBe('今天顶到 RPE9 了');
    expect(bondedCoach.status).toBe(200);
    expect(bondedCoach.body.reviews).toHaveLength(1);
    expect(otherStudent.status).toBe(403);
  });
});
