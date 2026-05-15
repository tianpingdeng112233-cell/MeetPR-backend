import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { auth, makeVideoContext, studentId } from './helpers/video';

describe('POST /privacy/consent', () => {
  it('inserts consent audit row and is idempotent', async () => {
    const ctx = await makeVideoContext();

    const first = await request(ctx.app)
      .post('/privacy/consent')
      .set(auth(ctx.studentToken))
      .set('User-Agent', 'MeetPRTests/1')
      .send({ kind: 'video_visibility_v1' });
    const second = await request(ctx.app)
      .post('/privacy/consent')
      .set(auth(ctx.studentToken))
      .set('User-Agent', 'MeetPRTests/2')
      .send({ kind: 'video_visibility_v1' });

    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    const rows = await ctx.db
      .selectFrom('privacy_consents')
      .selectAll()
      .where('user_id', '=', studentId)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      consent_kind: 'video_visibility_v1',
      user_agent: 'MeetPRTests/1',
    });
    expect(rows[0]?.ip_address).toBeTruthy();
  });
});
