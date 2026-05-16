import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { auth, giveVideoConsent, makeVideoContext, validVideoKey } from './helpers/video';

describe('POST /upload/abort', () => {
  it('aborts an owned multipart upload idempotently', async () => {
    const ctx = await makeVideoContext();
    await giveVideoConsent(ctx);

    const first = await request(ctx.app).post('/upload/abort').set(auth(ctx.studentToken)).send({
      upload_id: 'upload-test-1',
      oss_key: validVideoKey(),
    });
    const second = await request(ctx.app).post('/upload/abort').set(auth(ctx.studentToken)).send({
      upload_id: 'upload-test-1',
      oss_key: validVideoKey(),
    });

    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    expect(ctx.oss.aborted).toEqual([
      { key: validVideoKey(), uploadId: 'upload-test-1' },
      { key: validVideoKey(), uploadId: 'upload-test-1' },
    ]);
  });

  it('requires consent', async () => {
    const ctx = await makeVideoContext();
    const res = await request(ctx.app).post('/upload/abort').set(auth(ctx.studentToken)).send({
      upload_id: 'upload-test-1',
      oss_key: validVideoKey(),
    });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'CONSENT_MISSING' });
  });
});
