import { randomUUID } from 'node:crypto';

import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';

import { auth, config, ids, makeContext } from './helpers/bindEval';
import { request } from './helpers/inMemoryRequest';

describe('DELETE /me (spec 011 §1)', () => {
  it('deletes a student account and cascades their data', async () => {
    const ctx = await makeContext();

    // Leave a data trail first: an onboarding row for the solo student.
    const seeded = await request(ctx.app)
      .put('/students/me/onboarding')
      .set(auth(ctx.selfTrainStudentToken))
      .send({ unit_preference: 'kg' });
    expect(seeded.status).toBe(200);

    // A digest watermark row must not block deletion (0067 FKs cascade).
    await ctx.db
      .insertInto('digest_watermarks')
      .values({
        coach_id: ids.coach,
        student_id: ids.selfTrainStudent,
        last_gym_day: '2026-01-14',
      })
      .execute();

    const deleted = await request(ctx.app).delete('/me').set(auth(ctx.selfTrainStudentToken));
    expect(deleted.status).toBe(204);

    // Cascade proof: the onboarding row is gone with the user...
    const orphan = await ctx.db
      .selectFrom('student_onboarding_profiles')
      .selectAll()
      .where('user_id', '=', ids.selfTrainStudent)
      .executeTakeFirst();
    expect(orphan).toBeUndefined();
    const watermark = await ctx.db
      .selectFrom('digest_watermarks')
      .selectAll()
      .where('student_id', '=', ids.selfTrainStudent)
      .executeTakeFirst();
    expect(watermark).toBeUndefined();
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

  it('kills pre-migration legacy refresh tokens on password change', async () => {
    const ctx = await makeContext();
    const phone = '+8613900047002';

    const registered = await request(ctx.app)
      .post('/auth/register')
      .send({ phone, password: 'original-pass', role: 'self_train_student' });
    expect(registered.status).toBe(201);
    const accessToken: string = registered.body.accessToken;
    const userId: string = registered.body.user.id;

    // Rebuild the pre-migration state: a legacy jti on the user row with no
    // session rows backing it — the state /auth/refresh backfills from.
    const legacyJti = randomUUID();
    await ctx.db.deleteFrom('sessions').where('user_id', '=', userId).execute();
    await ctx.db
      .updateTable('users')
      .set({ refresh_token_jti: legacyJti })
      .where('id', '=', userId)
      .execute();

    const changed = await request(ctx.app)
      .put('/me/password')
      .set(auth(accessToken))
      .send({ old_password: 'original-pass', new_password: 'brand-new-pass' });
    expect(changed.status).toBe(204);

    const userRow = await ctx.db
      .selectFrom('users')
      .select(['refresh_token_jti'])
      .where('id', '=', userId)
      .executeTakeFirst();
    expect(userRow?.refresh_token_jti).toBeNull();

    // The legacy token can no longer resurrect a session after the change.
    const legacyRefresh = jwt.sign(
      { sub: userId, role: 'self_train_student', jti: legacyJti },
      config.JWT_REFRESH_SECRET,
      { algorithm: 'HS256', expiresIn: '30d' } satisfies SignOptions,
    );
    const refreshedLegacy = await request(ctx.app)
      .post('/auth/refresh')
      .send({ refreshToken: legacyRefresh });
    expect(refreshedLegacy.status).toBe(401);
    expect(refreshedLegacy.body).toEqual({ error: 'AUTH_INVALID_REFRESH' });

    const sessions = await ctx.db
      .selectFrom('sessions')
      .selectAll()
      .where('user_id', '=', userId)
      .execute();
    expect(sessions).toHaveLength(0);
  });
});
