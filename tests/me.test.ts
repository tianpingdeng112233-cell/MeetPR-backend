import { randomUUID } from 'node:crypto';

import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { auth, config, ids, makeContext } from './helpers/bindEval';
// The chat tables (spec 024) only exist in the studentActions harness, so the
// coached_student deletion case has to build its context from there.
import {
  ids as chatIds,
  makeContext as makeChatContext,
  type TestContext as ChatTestContext,
} from './helpers/studentActions';

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

// Regression: 0045 created the chat tables with plain `REFERENCES users(id)`
// (NO ACTION), so DELETE /me — a bare `DELETE FROM users` — hit 23503 and
// returned 500 for any coached_student who had ever chatted. Fixed by 0048.
// The pre-existing suite missed it because it only covered a self_train_student,
// who can never be a conversation member (the router requires coach or
// coached_student).
describe('DELETE /me with chat rows (migration 0048)', () => {
  async function openConversation(ctx: ChatTestContext): Promise<string> {
    // Disambiguate the two accepted bonds: the canonical coach is the one whose
    // acceptance is most recent.
    await ctx.db
      .updateTable('bind_requests')
      .set({ responded_at: new Date('2026-01-01T00:00:00.000Z') })
      .where('student_id', '=', chatIds.trainee)
      .execute();
    await ctx.db
      .updateTable('bind_requests')
      .set({ responded_at: new Date('2026-02-01T00:00:00.000Z') })
      .where('student_id', '=', chatIds.trainee)
      .where('coach_id', '=', chatIds.coach)
      .execute();

    const created = await request(ctx.app)
      .post('/conversations')
      .set(auth(ctx.coachToken))
      .send({ other_user_id: chatIds.trainee });
    expect(created.status).toBe(201);
    return (created.body as { conversation: { id: string } }).conversation.id;
  }

  it('deletes a coached_student who has a conversation, messages and a read cursor', async () => {
    const ctx = await makeChatContext();
    const conversationId = await openConversation(ctx);

    // Both parties leave a trail: the student's own message, the coach's reply,
    // and a read cursor per side.
    const fromStudent = await request(ctx.app)
      .post(`/conversations/${conversationId}/messages`)
      .set(auth(ctx.traineeToken))
      .send({ kind: 'text', body: 'ready for tomorrow', client_id: 'student-1' });
    expect(fromStudent.status).toBe(201);
    const fromCoach = await request(ctx.app)
      .post(`/conversations/${conversationId}/messages`)
      .set(auth(ctx.coachToken))
      .send({ kind: 'text', body: 'keep the bar path tight', client_id: 'coach-1' });
    expect(fromCoach.status).toBe(201);

    const studentRead = await request(ctx.app)
      .post(`/conversations/${conversationId}/read`)
      .set(auth(ctx.traineeToken))
      .send({ message_id: (fromCoach.body as { message: { id: string } }).message.id });
    expect(studentRead.status).toBe(200);
    const coachRead = await request(ctx.app)
      .post(`/conversations/${conversationId}/read`)
      .set(auth(ctx.coachToken))
      .send({ message_id: (fromStudent.body as { message: { id: string } }).message.id });
    expect(coachRead.status).toBe(200);

    expect(await ctx.db.selectFrom('messages').select('id').execute()).toHaveLength(2);
    expect(await ctx.db.selectFrom('conversation_reads').select('user_id').execute()).toHaveLength(
      2,
    );

    const deleted = await request(ctx.app).delete('/me').set(auth(ctx.traineeToken));
    expect(deleted.status).toBe(204);

    // The whole thread goes with the departing member — including the coach's
    // own messages and read cursor, which hang off the deleted conversation.
    expect(await ctx.db.selectFrom('conversations').select('id').execute()).toEqual([]);
    expect(await ctx.db.selectFrom('messages').select('id').execute()).toEqual([]);
    expect(await ctx.db.selectFrom('conversation_reads').select('user_id').execute()).toEqual([]);
    const userRow = await ctx.db
      .selectFrom('users')
      .select('id')
      .where('id', '=', chatIds.trainee)
      .executeTakeFirst();
    expect(userRow).toBeUndefined();

    // The cascade stops at the thread: the coach account survives untouched.
    const coachRow = await ctx.db
      .selectFrom('users')
      .select('id')
      .where('id', '=', chatIds.coach)
      .executeTakeFirst();
    expect(coachRow?.id).toBe(chatIds.coach);

    const again = await request(ctx.app).delete('/me').set(auth(ctx.traineeToken));
    expect(again.status).toBe(204);
  });

  it('deletes a coached_student whose conversation has no messages yet', async () => {
    const ctx = await makeChatContext();
    await openConversation(ctx);

    const deleted = await request(ctx.app).delete('/me').set(auth(ctx.traineeToken));
    expect(deleted.status).toBe(204);
    expect(await ctx.db.selectFrom('conversations').select('id').execute()).toEqual([]);
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
