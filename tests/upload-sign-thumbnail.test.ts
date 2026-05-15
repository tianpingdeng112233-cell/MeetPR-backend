import request from 'supertest';
import { describe, expect, it } from 'vitest';

import {
  auth,
  giveVideoConsent,
  makeVideoContext,
  planExerciseId,
  studentId,
} from './helpers/video';

describe('POST /upload/sign-thumbnail', () => {
  it('signs a single PUT URL without OSS server-side calls', async () => {
    const ctx = await makeVideoContext();
    await giveVideoConsent(ctx);

    const res = await request(ctx.app)
      .post('/upload/sign-thumbnail')
      .set(auth(ctx.studentToken))
      .send({
        plan_exercise_id: planExerciseId,
        set_index: 0,
        thumbnail_content_type: 'image/jpeg',
      });

    expect(res.status).toBe(200);
    expect(res.body.thumbnail_oss_key).toMatch(
      new RegExp(`^students/${studentId}/thumbs/${planExerciseId}/0/.+\\.jpg$`),
    );
    expect(res.body.presigned_url).toContain('method=PUT');
    expect(ctx.oss.initiated).toHaveLength(0);
    expect(ctx.oss.listedPrefixes).toHaveLength(0);
    expect(ctx.oss.signatures).toHaveLength(1);
  });

  it('requires consent', async () => {
    const ctx = await makeVideoContext();
    const res = await request(ctx.app)
      .post('/upload/sign-thumbnail')
      .set(auth(ctx.studentToken))
      .send({
        plan_exercise_id: planExerciseId,
        set_index: 0,
        thumbnail_content_type: 'image/jpeg',
      });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'CONSENT_MISSING' });
  });
});
