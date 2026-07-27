import { randomUUID } from 'node:crypto';

import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { auth, config, ids, makeContext } from './helpers/bindEval';

describe('DELETE /me (spec 011 §1)', () => {
  it('anonymizes a student account, keeping the training data behind it', async () => {
    const ctx = await makeContext();

    // Leave a data trail first: an onboarding row with free text the student
    // typed about themselves, plus a structured field that must survive.
    const seeded = await request(ctx.app)
      .put('/students/me/onboarding')
      .set(auth(ctx.selfTrainStudentToken))
      .send({
        unit_preference: 'kg',
        injury_notes: '右肩前侧疼,卧推时明显',
        note_to_coach: '我叫小明,平时晚上练',
      });
    expect(seeded.status).toBe(200);

    const before = await ctx.db
      .selectFrom('users')
      .select(['phone', 'password_hash'])
      .where('id', '=', ids.selfTrainStudent)
      .executeTakeFirstOrThrow();

    const deleted = await request(ctx.app).delete('/me').set(auth(ctx.selfTrainStudentToken));
    expect(deleted.status).toBe(204);

    // The row survives — training data keeps pointing at it — but nothing
    // identifying is left, and the phone number is released.
    const userRow = await ctx.db
      .selectFrom('users')
      .select(['phone', 'apple_user_id', 'password_hash', 'refresh_token_jti', 'deleted_at'])
      .where('id', '=', ids.selfTrainStudent)
      .executeTakeFirst();
    expect(userRow).toBeDefined();
    expect(userRow?.phone).toBeNull();
    expect(userRow?.apple_user_id).toBeNull();
    expect(userRow?.refresh_token_jti).toBeNull();
    expect(userRow?.password_hash).not.toBe(before.password_hash);
    expect(userRow?.deleted_at).not.toBeNull();

    // The onboarding row stays; only the free text is wiped.
    const onboarding = await ctx.db
      .selectFrom('student_onboarding_profiles')
      .select(['unit_preference', 'injury_notes', 'note_to_coach'])
      .where('user_id', '=', ids.selfTrainStudent)
      .executeTakeFirst();
    expect(onboarding).toBeDefined();
    expect(onboarding?.injury_notes).toBeNull();
    expect(onboarding?.note_to_coach).toBeNull();
    expect(onboarding?.unit_preference).toBe('kg');

    // The released number registers again as a brand-new account.
    const reregistered = await request(ctx.app)
      .post('/auth/register')
      .send({ phone: before.phone, password: 'a-fresh-password', role: 'self_train_student' });
    expect(reregistered.status).toBe(201);
    expect(reregistered.body.user.id).not.toBe(ids.selfTrainStudent);

    // A repeat delete stays 204 and does not re-stamp deleted_at (idempotent).
    const again = await request(ctx.app).delete('/me').set(auth(ctx.selfTrainStudentToken));
    expect(again.status).toBe(204);
    const after = await ctx.db
      .selectFrom('users')
      .select(['deleted_at'])
      .where('id', '=', ids.selfTrainStudent)
      .executeTakeFirst();
    expect(after?.deleted_at).toEqual(userRow?.deleted_at);
  });

  it('refuses coach deletion (offboarding is out of scope)', async () => {
    const ctx = await makeContext();

    const response = await request(ctx.app).delete('/me').set(auth(ctx.coachToken));
    expect(response.status).toBe(403);
    // requireRole's generic code, not the spec's early-draft
    // COACH_DELETE_UNSUPPORTED — see spec 011 §1.1 divergence note.
    expect(response.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });

    const userRow = await ctx.db
      .selectFrom('users')
      .select(['phone', 'deleted_at'])
      .where('id', '=', ids.coach)
      .executeTakeFirst();
    expect(userRow?.phone).toBe('+8613800005001');
    expect(userRow?.deleted_at).toBeNull();
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
