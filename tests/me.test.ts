import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { auth, ids, makeContext } from './helpers/bindEval';

describe('DELETE /me (spec 011 §1)', () => {
  it('deletes a student account and cascades their data', async () => {
    const ctx = await makeContext();

    // Leave a data trail first: an onboarding row for the solo student.
    const seeded = await request(ctx.app)
      .put('/students/me/onboarding')
      .set(auth(ctx.selfTrainStudentToken))
      .send({ unit_preference: 'kg' });
    expect(seeded.status).toBe(200);

    const deleted = await request(ctx.app).delete('/me').set(auth(ctx.selfTrainStudentToken));
    expect(deleted.status).toBe(204);

    // Cascade proof: the onboarding row is gone with the user...
    const orphan = await ctx.db
      .selectFrom('student_onboarding_profiles')
      .selectAll()
      .where('user_id', '=', ids.selfTrainStudent)
      .executeTakeFirst();
    expect(orphan).toBeUndefined();
    const userRow = await ctx.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', ids.selfTrainStudent)
      .executeTakeFirst();
    expect(userRow).toBeUndefined();

    // ...and a repeat delete stays 204 (idempotent, 0 rows affected).
    const again = await request(ctx.app).delete('/me').set(auth(ctx.selfTrainStudentToken));
    expect(again.status).toBe(204);
  });

  it('refuses coach deletion (offboarding is out of scope)', async () => {
    const ctx = await makeContext();

    const response = await request(ctx.app).delete('/me').set(auth(ctx.coachToken));
    expect(response.status).toBe(403);

    const userRow = await ctx.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', ids.coach)
      .executeTakeFirst();
    expect(userRow).toBeDefined();
  });
});

describe('PUT /me/password (spec 011 §2)', () => {
  it('rotates the password and revokes refresh tokens', async () => {
    const ctx = await makeContext();
    const phone = '+8613900047001';

    const registered = await request(ctx.app)
      .post('/auth/register')
      .send({ phone, password: 'original-pass', role: 'self_train_student' });
    expect(registered.status).toBe(201);
    const accessToken: string = registered.body.accessToken;
    const refreshToken: string = registered.body.refreshToken;

    const wrongOld = await request(ctx.app)
      .put('/me/password')
      .set(auth(accessToken))
      .send({ old_password: 'not-the-password', new_password: 'brand-new-pass' });
    expect(wrongOld.status).toBe(403);
    expect(wrongOld.body).toEqual({ error: 'PASSWORD_MISMATCH' });

    const changed = await request(ctx.app)
      .put('/me/password')
      .set(auth(accessToken))
      .send({ old_password: 'original-pass', new_password: 'brand-new-pass' });
    expect(changed.status).toBe(204);

    // Old password stops working, the new one logs in.
    const oldLogin = await request(ctx.app)
      .post('/auth/login')
      .send({ phone, password: 'original-pass' });
    expect(oldLogin.status).toBe(401);
    const newLogin = await request(ctx.app)
      .post('/auth/login')
      .send({ phone, password: 'brand-new-pass' });
    expect(newLogin.status).toBe(200);

    // Every refresh token from before the change is revoked.
    const refreshed = await request(ctx.app).post('/auth/refresh').send({ refreshToken });
    expect(refreshed.status).toBe(401);
  });
});
