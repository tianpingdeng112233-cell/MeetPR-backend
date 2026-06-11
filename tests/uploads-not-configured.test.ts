import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { auth, makeContext } from './helpers/studentActions';
import { validInitiateBody } from './helpers/uploads';

describe('/uploads without OSS configuration', () => {
  it('answers 503 UPLOADS_NOT_CONFIGURED on every endpoint', async () => {
    // No oss service injected — mirrors local dev without OSS env vars.
    const ctx = await makeContext();
    const id = '99999999-0000-4000-8000-000000000099';

    const initiate = await request(ctx.app)
      .post('/uploads/initiate')
      .set(auth(ctx.traineeToken))
      .send(validInitiateBody);
    const complete = await request(ctx.app)
      .post(`/uploads/${id}/complete`)
      .set(auth(ctx.traineeToken))
      .send({ parts: [{ part_number: 1, etag: 'etag-1' }] });
    const abort = await request(ctx.app)
      .post(`/uploads/${id}/abort`)
      .set(auth(ctx.traineeToken))
      .send({});
    const url = await request(ctx.app).get(`/uploads/${id}/url`).set(auth(ctx.traineeToken));

    for (const res of [initiate, complete, abort, url]) {
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'UPLOADS_NOT_CONFIGURED' });
    }
  });

  it('still requires authentication before the 503 gate', async () => {
    const ctx = await makeContext();

    const res = await request(ctx.app).post('/uploads/initiate').send(validInitiateBody);

    expect(res.status).toBe(401);
  });
});
