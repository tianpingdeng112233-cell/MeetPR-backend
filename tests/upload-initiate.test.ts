import request from 'supertest';
import { describe, expect, it } from 'vitest';

import {
  auth,
  giveVideoConsent,
  makeVideoContext,
  planExerciseId,
  studentId,
} from './helpers/video';

describe('POST /upload/initiate', () => {
  it('requires prior video consent', async () => {
    const ctx = await makeVideoContext();
    const res = await request(ctx.app).post('/upload/initiate').set(auth(ctx.studentToken)).send({
      plan_exercise_id: planExerciseId,
      set_index: 0,
      content_type: 'video/mp4',
      part_count: 1,
    });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'CONSENT_MISSING' });
  });

  it('initiates multipart upload and returns snake_case presigned part URLs', async () => {
    const ctx = await makeVideoContext();
    await giveVideoConsent(ctx);

    const res = await request(ctx.app).post('/upload/initiate').set(auth(ctx.studentToken)).send({
      plan_exercise_id: planExerciseId,
      set_index: 0,
      content_type: 'video/mp4',
      part_count: 2,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      upload_id: 'upload-test-1',
      presigned_parts: [{ part_number: 1 }, { part_number: 2 }],
    });
    expect(res.body.uploadId).toBeUndefined();
    expect(res.body.oss_key).toMatch(
      new RegExp(`^students/${studentId}/sets/${planExerciseId}/0/.+\\.mp4$`),
    );
    expect(ctx.oss.initiated).toHaveLength(1);
    expect(ctx.oss.signatures).toHaveLength(2);
  });

  it('rejects non-student roles', async () => {
    const ctx = await makeVideoContext();
    const res = await request(ctx.app).post('/upload/initiate').set(auth(ctx.coachToken)).send({
      plan_exercise_id: planExerciseId,
      set_index: 0,
      content_type: 'video/mp4',
      part_count: 1,
    });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });
  });

  it('rejects plan exercises outside a published student plan', async () => {
    const ctx = await makeVideoContext();
    await giveVideoConsent(ctx);

    const res = await request(ctx.app).post('/upload/initiate').set(auth(ctx.studentToken)).send({
      plan_exercise_id: '20000000-0000-4000-8000-000000000099',
      set_index: 0,
      content_type: 'video/mp4',
      part_count: 1,
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'UPLOAD_PLAN_EXERCISE_NOT_PUBLISHED' });
  });
});
