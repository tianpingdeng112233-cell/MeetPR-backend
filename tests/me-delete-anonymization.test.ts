import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import type { TestContext } from './helpers/studentActions';
import { auth, createPublishedPlan, ids, makeContext } from './helpers/studentActions';

// The pre-existing DELETE /me coverage (tests/me.test.ts) only ever exercised a
// self-train student with an onboarding row — no coach, no chat, no plans, none
// of the tables that used to make a hard delete impossible. This file covers the
// shape that actually matters after the 2026-07-27 revision: a coached student
// with a full data trail behind them (spec 011 §1).

const TRAINEE_PHONE = '+8613800001003';

async function seedTrail(ctx: TestContext): Promise<{ conversationId: string }> {
  // Both bonds get a response date, then the coach's is made the most recent so
  // they are unambiguously the active coach (the single-active-coach rule picks
  // the latest response — same setup as tests/chat-messages.test.ts).
  await ctx.db
    .updateTable('bind_requests')
    .set({ responded_at: new Date('2026-01-01T00:00:00.000Z') })
    .where('student_id', '=', ids.trainee)
    .execute();
  await ctx.db
    .updateTable('bind_requests')
    .set({ responded_at: new Date('2026-02-01T00:00:00.000Z') })
    .where('student_id', '=', ids.trainee)
    .where('coach_id', '=', ids.coach)
    .execute();

  const fixture = await createPublishedPlan(ctx);

  await ctx.db
    .insertInto('set_logs')
    .values({
      student_id: ids.trainee,
      plan_exercise_id: fixture.planExerciseId,
      exercise_id: ids.exercise,
      set_index: 1,
      weight_kg: '100.00',
      reps: 5,
      rpe: '8.0',
      completed: true,
      logged_date: '2026-05-01',
    })
    .execute();

  await ctx.db
    .insertInto('student_onboarding_profiles')
    .values({
      user_id: ids.trainee,
      unit_preference: 'kg',
      gender: 'male',
      squat_1rm_kg: '180.00',
      injury_areas: ['shoulder'],
      injury_notes: '右肩前侧疼,卧推时明显',
      note_to_coach: '我叫小明,住在杭州,平时晚上练',
    })
    .execute();

  // Two live sessions (multi-device, migration 0039) plus a push registration.
  await ctx.db
    .insertInto('sessions')
    .values([
      { user_id: ids.trainee, refresh_token_jti: randomUUID() },
      { user_id: ids.trainee, refresh_token_jti: randomUUID() },
    ])
    .execute();
  await ctx.db
    .insertInto('device_tokens')
    .values({ user_id: ids.trainee, token: 'apns-token-trainee', platform: 'ios' })
    .execute();

  const conversation = await request(ctx.app)
    .post('/conversations')
    .set(auth(ctx.coachToken))
    .send({ other_user_id: ids.trainee });
  expect(conversation.status).toBe(201);
  const conversationId = (conversation.body as { conversation: { id: string } }).conversation.id;

  const message = await request(ctx.app)
    .post(`/conversations/${conversationId}/messages`)
    .set(auth(ctx.traineeToken))
    .send({ kind: 'text', body: '教练这周深蹲有点重', client_id: 'msg-1' });
  expect(message.status).toBe(201);

  return { conversationId };
}

async function countRows(ctx: TestContext): Promise<Record<string, number>> {
  const tables = ['plans', 'plan_days', 'plan_exercises', 'plan_sets', 'set_logs'] as const;
  const counts: Record<string, number> = {};
  for (const table of tables) {
    counts[table] = (await ctx.db.selectFrom(table).selectAll().execute()).length;
  }
  counts.conversations = (await ctx.db.selectFrom('conversations').selectAll().execute()).length;
  counts.messages = (await ctx.db.selectFrom('messages').selectAll().execute()).length;
  counts.bind_requests = (await ctx.db.selectFrom('bind_requests').selectAll().execute()).length;
  counts.student_onboarding_profiles = (
    await ctx.db.selectFrom('student_onboarding_profiles').selectAll().execute()
  ).length;
  return counts;
}

describe('DELETE /me anonymization, coached student (spec 011 §1)', () => {
  it('wipes every identifier while every training row stays put', async () => {
    const ctx = await makeContext();
    await seedTrail(ctx);

    const before = await countRows(ctx);
    const beforeUser = await ctx.db
      .selectFrom('users')
      .select(['phone', 'password_hash'])
      .where('id', '=', ids.trainee)
      .executeTakeFirstOrThrow();
    expect(beforeUser.phone).toBe(TRAINEE_PHONE);

    const deleted = await request(ctx.app).delete('/me').set(auth(ctx.traineeToken));
    expect(deleted.status).toBe(204);

    // 1. PII is gone.
    const userRow = await ctx.db
      .selectFrom('users')
      .select([
        'phone',
        'apple_user_id',
        'password_hash',
        'refresh_token_jti',
        'deleted_at',
        'role',
      ])
      .where('id', '=', ids.trainee)
      .executeTakeFirstOrThrow();
    expect(userRow.phone).toBeNull();
    expect(userRow.apple_user_id).toBeNull();
    expect(userRow.refresh_token_jti).toBeNull();
    expect(userRow.password_hash).not.toBe(beforeUser.password_hash);
    expect(userRow.deleted_at).not.toBeNull();
    expect(userRow.role).toBe('coached_student');

    const profile = await ctx.db
      .selectFrom('student_profiles')
      .select(['display_name'])
      .where('user_id', '=', ids.trainee)
      .executeTakeFirstOrThrow();
    expect(profile.display_name).toBe('已注销用户');

    const onboarding = await ctx.db
      .selectFrom('student_onboarding_profiles')
      .select(['injury_notes', 'note_to_coach', 'gender', 'squat_1rm_kg', 'injury_areas'])
      .where('user_id', '=', ids.trainee)
      .executeTakeFirstOrThrow();
    expect(onboarding.injury_notes).toBeNull();
    expect(onboarding.note_to_coach).toBeNull();
    // Structured algorithm inputs are deliberately kept (spec 011 §1.3).
    expect(onboarding.gender).toBe('male');
    expect(Number(onboarding.squat_1rm_kg)).toBe(180);
    expect(onboarding.injury_areas).toEqual(['shoulder']);

    // 2. Every credential is revoked.
    const sessions = await ctx.db
      .selectFrom('sessions')
      .select(['revoked_at'])
      .where('user_id', '=', ids.trainee)
      .execute();
    expect(sessions).toHaveLength(2);
    expect(sessions.every((session) => session.revoked_at !== null)).toBe(true);

    const deviceTokens = await ctx.db
      .selectFrom('device_tokens')
      .selectAll()
      .where('user_id', '=', ids.trainee)
      .execute();
    expect(deviceTokens).toHaveLength(0);

    // 3. Not one training row moved.
    expect(await countRows(ctx)).toEqual(before);

    // The coach's messages and the student's own message both survive, still
    // attributed to the (now nameless) user id.
    const studentMessages = await ctx.db
      .selectFrom('messages')
      .select(['body'])
      .where('sender_id', '=', ids.trainee)
      .execute();
    expect(studentMessages).toHaveLength(1);
  });

  it('releases the phone number for a fresh registration', async () => {
    const ctx = await makeContext();
    await seedTrail(ctx);

    expect((await request(ctx.app).delete('/me').set(auth(ctx.traineeToken))).status).toBe(204);

    // The number no longer resolves to any live account...
    const oldLogin = await request(ctx.app)
      .post('/auth/login')
      .send({ phone: TRAINEE_PHONE, password: 'whatever-they-used' });
    expect(oldLogin.status).toBe(401);

    // ...and the same number registers as an entirely new account.
    const registered = await request(ctx.app)
      .post('/auth/register')
      .send({ phone: TRAINEE_PHONE, password: 'a-fresh-password', role: 'coached_student' });
    expect(registered.status).toBe(201);
    const newUserId = (registered.body as { user: { id: string } }).user.id;
    expect(newUserId).not.toBe(ids.trainee);

    // The new account starts empty: nothing followed the number over.
    const inheritedSets = await ctx.db
      .selectFrom('set_logs')
      .selectAll()
      .where('student_id', '=', newUserId)
      .execute();
    expect(inheritedSets).toHaveLength(0);

    const relogin = await request(ctx.app)
      .post('/auth/login')
      .send({ phone: TRAINEE_PHONE, password: 'a-fresh-password' });
    expect(relogin.status).toBe(200);
    expect((relogin.body as { user: { id: string } }).user.id).toBe(newUserId);
  });
});
