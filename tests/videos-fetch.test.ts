import request from 'supertest';
import { describe, expect, it } from 'vitest';

import {
  auth,
  insertVideo,
  makeVideoContext,
  otherCoachPlanExerciseId,
  otherStudentId,
  planExerciseId,
  studentId,
  validThumbnailKey,
  validVideoKey,
} from './helpers/video';

describe('GET /students/:id/videos', () => {
  it('lets students read all of their own videos ordered by recorded_at desc', async () => {
    const ctx = await makeVideoContext();
    await insertVideo(ctx, {
      set_index: 0,
      oss_key: validVideoKey(studentId, planExerciseId, 0),
      recorded_at: new Date('2026-05-15T10:00:00.000Z'),
    });
    await insertVideo(ctx, {
      set_index: 1,
      oss_key: validVideoKey(studentId, planExerciseId, 1),
      thumbnail_oss_key: validThumbnailKey(studentId, planExerciseId, 1),
      recorded_at: new Date('2026-05-15T12:00:00.000Z'),
    });

    const res = await request(ctx.app)
      .get(`/students/${studentId}/videos`)
      .set(auth(ctx.studentToken));

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].set_index).toBe(1);
    expect(res.body.items[1].set_index).toBe(0);
    expect(res.body.items[0].video_url).toContain('method=GET');
  });

  it('filters coach reads to videos from the coach-owned published plan only', async () => {
    const ctx = await makeVideoContext();
    await insertVideo(ctx, {
      set_index: 0,
      plan_exercise_id: planExerciseId,
      oss_key: validVideoKey(studentId, planExerciseId, 0),
      thumbnail_oss_key: validThumbnailKey(studentId, planExerciseId, 0),
    });
    await insertVideo(ctx, {
      set_index: 0,
      plan_exercise_id: otherCoachPlanExerciseId,
      oss_key: validVideoKey(studentId, otherCoachPlanExerciseId, 0),
      thumbnail_oss_key: validThumbnailKey(studentId, otherCoachPlanExerciseId, 0),
    });

    const coachRes = await request(ctx.app)
      .get(`/students/${studentId}/videos`)
      .set(auth(ctx.coachToken));
    const otherCoachRes = await request(ctx.app)
      .get(`/students/${studentId}/videos`)
      .set(auth(ctx.otherCoachToken));

    expect(coachRes.status).toBe(200);
    expect(coachRes.body.items).toHaveLength(1);
    expect(coachRes.body.items[0].plan_exercise_id).toBe(planExerciseId);
    expect(otherCoachRes.status).toBe(200);
    expect(otherCoachRes.body.items).toHaveLength(1);
    expect(otherCoachRes.body.items[0].plan_exercise_id).toBe(otherCoachPlanExerciseId);
  });

  it('forbids coaches without a published plan for that student', async () => {
    const ctx = await makeVideoContext();
    const res = await request(ctx.app)
      .get(`/students/${otherStudentId}/videos`)
      .set(auth(ctx.coachToken));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });
  });
});
