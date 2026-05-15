import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { auth, giveVideoConsent, makeVideoContext, planExerciseId } from '../helpers/video';

describe('upload DTO snake_case validation', () => {
  it('rejects camelCase upload input and responds with snake_case fields on success', async () => {
    const ctx = await makeVideoContext();
    const invalid = await request(ctx.app)
      .post('/upload/initiate')
      .set(auth(ctx.studentToken))
      .send({
        planExerciseId,
        setIndex: 0,
        contentType: 'video/mp4',
        partCount: 1,
      });

    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(invalid.body)).toContain('plan_exercise_id');

    await giveVideoConsent(ctx);
    const valid = await request(ctx.app).post('/upload/initiate').set(auth(ctx.studentToken)).send({
      plan_exercise_id: planExerciseId,
      set_index: 0,
      content_type: 'video/mp4',
      part_count: 1,
    });

    expect(valid.status).toBe(200);
    expect(valid.body.upload_id).toBe('upload-test-1');
    expect(valid.body.presigned_parts[0]).toHaveProperty('part_number', 1);
    expect(valid.body.uploadId).toBeUndefined();
    expect(valid.body.presignedParts).toBeUndefined();
  });
});
