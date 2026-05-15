import request from 'supertest';
import { describe, expect, it } from 'vitest';

import {
  auth,
  giveVideoConsent,
  makeVideoContext,
  validThumbnailKey,
  validVideoKey,
} from './helpers/video';

describe('POST /upload/sign-parts', () => {
  it('re-signs requested part URLs without OSS calls', async () => {
    const ctx = await makeVideoContext();
    await giveVideoConsent(ctx);

    const res = await request(ctx.app)
      .post('/upload/sign-parts')
      .set(auth(ctx.studentToken))
      .send({
        upload_id: 'upload-test-1',
        oss_key: validVideoKey(),
        part_numbers: [1, 7],
      });

    expect(res.status).toBe(200);
    expect(res.body.presigned_parts).toMatchObject([{ part_number: 1 }, { part_number: 7 }]);
    expect(ctx.oss.initiated).toHaveLength(0);
    expect(ctx.oss.listedPrefixes).toHaveLength(0);
    expect(ctx.oss.signatures).toHaveLength(2);
  });

  it('rejects thumbnail keys for video part signing', async () => {
    const ctx = await makeVideoContext();
    await giveVideoConsent(ctx);

    const res = await request(ctx.app)
      .post('/upload/sign-parts')
      .set(auth(ctx.studentToken))
      .send({
        upload_id: 'upload-test-1',
        oss_key: validThumbnailKey(),
        part_numbers: [1],
      });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'UPLOAD_OSS_KEY_OWNERSHIP' });
  });
});
