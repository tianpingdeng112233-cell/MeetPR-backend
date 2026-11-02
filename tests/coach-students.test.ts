import fs from 'node:fs';
import { sql } from 'kysely';
import { request } from './helpers/inMemoryRequest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { auth, createPublishedPlan, ids, makeContext, signToken } from './helpers/studentActions';

describe('GET /coach/students', () => {
  it('returns accepted bonded students with snake_case profile fields', async () => {
    const ctx = await makeContext();

    const res = await request(ctx.app).get('/coach/students').set(auth(ctx.coachToken));

    expect(res.status).toBe(200);
    expect(res.body.students).toHaveLength(1);
    expect(res.body.students[0]).toMatchObject({
      id: ids.trainee,
      display_name: 'Trainee One',
      profile: {
        user_id: ids.trainee,
        display_name: 'Trainee One',
      },
      status: 'active',
      evaluation: null,
    });
    expect(res.body.students[0].profile.created_at).toEqual(expect.any(String));
  });

  it('keeps students without a profile row on the roster with an empty name', async () => {
    const ctx = await makeContext();
    // No DB constraint ties accepted bonds to student_profiles (only the
    // bind-request flow bootstraps the row), so the roster must not drop
    // students whose profile is missing.
    await ctx.db.deleteFrom('student_profiles').where('user_id', '=', ids.trainee).execute();

    const res = await request(ctx.app).get('/coach/students').set(auth(ctx.coachToken));

    expect(res.status).toBe(200);
    expect(res.body.students).toHaveLength(1);
    expect(res.body.students[0]).toMatchObject({
      id: ids.trainee,
      display_name: '',
      profile: { user_id: ids.trainee, display_name: '' },
      status: 'active',
      evaluation: null,
    });
    // With no profile row, created_at falls back to the user's registration time.
    const user = await ctx.db
      .selectFrom('users')
      .select('created_at')
      .where('id', '=', ids.trainee)
      .executeTakeFirstOrThrow();
    expect(res.body.students[0].profile.created_at).toBe(user.created_at.toISOString());
  });

  it('returns an empty list when the coach has no accepted bonds', async () => {
    const ctx = await makeContext();
    await ctx.db.deleteFrom('bind_requests').where('coach_id', '=', ids.coach).execute();

    const res = await request(ctx.app).get('/coach/students').set(auth(ctx.coachToken));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ students: [] });
  });

  it('requires auth and coach role', async () => {
    const ctx = await makeContext();

    const noToken = await request(ctx.app).get('/coach/students');
    const asStudent = await request(ctx.app).get('/coach/students').set(auth(ctx.traineeToken));

    expect(noToken.status).toBe(401);
    expect(asStudent.status).toBe(403);
    expect(asStudent.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });
  });

  it('marks students with an active evaluation period as in_evaluation', async () => {
    const ctx = await makeContext();
    const bond = await ctx.db
      .selectFrom('bind_requests')
      .select(['id'])
      .where('student_id', '=', ids.trainee)
      .where('coach_id', '=', ids.coach)
      .executeTakeFirstOrThrow();
    await ctx.db
      .insertInto('evaluation_periods')
      .values({
        student_id: ids.trainee,
        coach_id: ids.coach,
        bind_request_id: bond.id,
        expected_end_at: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      })
      .execute();

    const res = await request(ctx.app).get('/coach/students').set(auth(ctx.coachToken));

    expect(res.status).toBe(200);
    const student = res.body.students[0];
    expect(student.status).toBe('in_evaluation');
    expect(student.evaluation).toMatchObject({ overdue: false });
    expect(student.evaluation.expected_end_at).toEqual(expect.any(String));

    // Completing the evaluation flips the roster back to active.
    await ctx.db
      .updateTable('evaluation_periods')
      .set({ completed_at: new Date(), completion_type: 'coach_completed' })
      .where('student_id', '=', ids.trainee)
      .execute();
    const after = await request(ctx.app).get('/coach/students').set(auth(ctx.coachToken));
    expect(after.body.students[0].status).toBe('active');
    expect(after.body.students[0].evaluation).toBeNull();
  });
});

describe('PATCH /coach/students/:id', () => {
  it('treats legacy display_name as a trimmed private alias without renaming the student', async () => {
    const ctx = await makeContext();

    const renamed = await request(ctx.app)
      .patch(`/coach/students/${ids.trainee}`)
      .set(auth(ctx.coachToken))
      .send({ display_name: '  王馨伟  ' });

    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({
      id: ids.trainee,
      alias: '王馨伟',
      display_name: 'Trainee One',
      profile: { user_id: ids.trainee, display_name: 'Trainee One' },
    });
    const profile = await ctx.db
      .selectFrom('student_profiles')
      .select('display_name')
      .where('user_id', '=', ids.trainee)
      .executeTakeFirstOrThrow();
    expect(profile.display_name).toBe('Trainee One');
  });

  it('stores an alias without creating a missing student profile', async () => {
    const ctx = await makeContext();
    await ctx.db.deleteFrom('student_profiles').where('user_id', '=', ids.trainee).execute();

    const renamed = await request(ctx.app)
      .patch(`/coach/students/${ids.trainee}`)
      .set(auth(ctx.coachToken))
      .send({ display_name: '补建档案' });

    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({
      id: ids.trainee,
      alias: '补建档案',
      display_name: '',
      profile: { user_id: ids.trainee, display_name: '' },
    });
    const profile = await ctx.db
      .selectFrom('student_profiles')
      .select('display_name')
      .where('user_id', '=', ids.trainee)
      .executeTakeFirst();
    expect(profile).toBeUndefined();
  });

  it('rejects unbound students without revealing whether the profile exists', async () => {
    const ctx = await makeContext();

    const res = await request(ctx.app)
      .patch(`/coach/students/${ids.otherStudent}`)
      .set(auth(ctx.coachToken))
      .send({ display_name: '不应修改' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'COACH_STUDENT_NOT_FOUND' });
  });

  it('requires coach role and validates the new name', async () => {
    const ctx = await makeContext();

    const asStudent = await request(ctx.app)
      .patch(`/coach/students/${ids.trainee}`)
      .set(auth(ctx.traineeToken))
      .send({ display_name: '新名字' });
    const blank = await request(ctx.app)
      .patch(`/coach/students/${ids.trainee}`)
      .set(auth(ctx.coachToken))
      .send({ display_name: '   ' });
    const extraField = await request(ctx.app)
      .patch(`/coach/students/${ids.trainee}`)
      .set(auth(ctx.coachToken))
      .send({ display_name: '新名字', role: 'coach' });

    expect(asStudent.status).toBe(403);
    expect(blank.status).toBe(200);
    expect(blank.body.alias).toBeNull();
    expect(extraField.status).toBe(400);
  });
});

describe('POST /coach/students/:id/unbind', () => {
  it('ends only the accepted bond and returns 404 on repeat', async () => {
    const ctx = await makeContext();
    const unbind = () =>
      request(ctx.app).post(`/coach/students/${ids.trainee}/unbind`).set(auth(ctx.coachToken));
    expect((await unbind()).status).toBe(200);
    const bond = await ctx.db
      .selectFrom('bind_requests')
      .selectAll()
      .where('coach_id', '=', ids.coach)
      .where('student_id', '=', ids.trainee)
      .executeTakeFirstOrThrow();
    expect(bond).toMatchObject({ status: 'ended', ended_at: expect.any(Date) });
    expect(
      (await request(ctx.app).get('/coach/students').set(auth(ctx.coachToken))).body.students,
    ).toEqual([]);
    const repeated = await unbind();
    expect(repeated.status).toBe(404);
    expect(repeated.body).toEqual({ error: 'COACH_STUDENT_NOT_FOUND' });
  });
});

it.each([null, '', '  '])('sets an alias and clears it with %s', async (clear) => {
  const ctx = await makeContext();
  const patch = (alias: string | null) =>
    request(ctx.app)
      .patch(`/coach/students/${ids.trainee}`)
      .set(auth(ctx.coachToken))
      .send({ alias });
  const named = await patch('  小王  ');
  expect(named.status).toBe(200);
  expect(named.body).toMatchObject({ alias: '小王', display_name: 'Trainee One' });
  const cleared = await patch(clear);
  expect(cleared.status).toBe(200);
  expect(cleared.body.alias).toBeNull();
  await request(ctx.app).post(`/coach/students/${ids.trainee}/unbind`).set(auth(ctx.coachToken));
  expect((await patch('禁止修改')).status).toBe(404);
});

it('includes ended students only on request and preserves the alias across rebinds', async () => {
  const ctx = await makeContext();
  await request(ctx.app)
    .patch(`/coach/students/${ids.trainee}`)
    .set(auth(ctx.coachToken))
    .send({ alias: '老学员' });
  const unbind = () =>
    request(ctx.app).post(`/coach/students/${ids.trainee}/unbind`).set(auth(ctx.coachToken));
  await unbind();
  const roster = () =>
    request(ctx.app).get('/coach/students?include_ended=1').set(auth(ctx.coachToken));
  const ended = await roster();
  expect(ended.status).toBe(200);
  expect(ended.body.students).toHaveLength(1);
  expect(ended.body.students[0]).toMatchObject({
    alias: '老学员',
    bond_status: 'ended',
    ended_at: expect.any(String),
    today: null,
  });
  await ctx.db
    .insertInto('bind_requests')
    .values({
      student_id: ids.trainee,
      coach_id: ids.coach,
      status: 'accepted',
      expired_at: new Date(),
    })
    .execute();
  const rebound = await roster();
  expect(rebound.body.students).toHaveLength(1);
  expect(rebound.body.students[0]).toMatchObject({
    alias: '老学员',
    bond_status: 'active',
    ended_at: null,
  });
  await unbind();
  expect((await roster()).body.students).toHaveLength(1);
});

afterEach(() => vi.useRealTimers());

it.each([
  ['Asia/Shanghai', '2026-11-01T19:59:59Z', '2026-11-01T20:00:00Z'],
  ['America/Los_Angeles', '2026-11-02T11:59:59Z', '2026-11-02T12:00:00Z'],
])(
  'uses training-day 04:00 boundaries in %s for all today states',
  async (timezone, before, boundary) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(before));
    const ctx = await makeContext();
    await ctx.db.updateTable('users').set({ timezone }).where('id', '=', ids.trainee).execute();
    const plan = await createPublishedPlan(ctx);
    await ctx.db
      .updateTable('plans')
      .set({ start_date: '2026-11-01', end_date: '2026-11-07' })
      .where('id', '=', plan.planId)
      .execute();
    const roster = () => request(ctx.app).get('/coach/students').set(auth(ctx.coachToken));
    expect((await roster()).body.students[0].today).toEqual({
      state: 'scheduled',
      completed_at: null,
    });
    vi.setSystemTime(new Date(boundary));
    expect((await roster()).body.students[0].today).toEqual({ state: 'rest', completed_at: null });
    // Latest shift overrides the positional Nov 1 recommendation.
    await ctx.db
      .insertInto('plan_day_shifts')
      .values({
        plan_day_id: plan.dayId,
        student_id: ids.trainee,
        batch_id: '90000000-0000-4000-8000-000000000057',
        shifted_to_date: '2026-11-02',
      })
      .execute();
    expect((await roster()).body.students[0].today).toEqual({
      state: 'scheduled',
      completed_at: null,
    });
    await ctx.db
      .insertInto('plan_day_completions')
      .values({
        plan_day_id: plan.dayId,
        student_id: ids.trainee,
        source: 'manual',
        completed_at: new Date(before),
      })
      .execute();
    // A completed training day cannot remain scheduled on its recommended day.
    expect((await roster()).body.students[0].today).toEqual({ state: 'rest', completed_at: null });
    await ctx.db
      .updateTable('plan_day_completions')
      .set({ completed_at: new Date(boundary) })
      .where('plan_day_id', '=', plan.dayId)
      .execute();
    expect((await roster()).body.students[0].today).toEqual({
      state: 'completed',
      completed_at: new Date(boundary).toISOString(),
    });
    const second = await createPublishedPlan(ctx);
    await ctx.db
      .insertInto('plan_day_completions')
      .values({
        plan_day_id: second.dayId,
        student_id: ids.trainee,
        source: 'manual',
        completed_at: new Date(new Date(boundary).getTime() + 1000),
      })
      .execute();
    expect((await roster()).body.students[0].today.completed_at).toBe(
      new Date(boundary).toISOString(),
    );
    // Old completions still suppress a scheduled day, even outside the today window.
    await ctx.db
      .updateTable('plan_day_completions')
      .set({ completed_at: new Date('2026-10-01T00:00:00Z') })
      .execute();
    expect((await roster()).body.students[0].today).toEqual({ state: 'rest', completed_at: null });
  },
);

it('counts only visible ready unviewed videos and keeps queries constant for fifty students', async () => {
  const queries: string[] = [];
  const ctx = await makeContext(undefined, {
    afterQuery: (query) => {
      queries.push(query);
      return Promise.resolve();
    },
  });
  await ctx.db
    .insertInto('attachments')
    .values(
      [
        { source_coach_id: ids.coach, is_unlinked_explicit: false },
        { source_coach_id: null, is_unlinked_explicit: true },
        { source_coach_id: ids.otherCoach, is_unlinked_explicit: false },
        { source_coach_id: null, is_unlinked_explicit: false },
        { source_coach_id: ids.coach, is_unlinked_explicit: false, coach_viewed_at: new Date() },
        { source_coach_id: ids.coach, is_unlinked_explicit: false, status: 'uploading' as const },
      ].map((fields, i) => ({
        owner_id: ids.trainee,
        kind: 'set_video' as const,
        oss_key: `057-${String(i)}`,
        content_type: 'video/mp4',
        size_bytes: 100,
        part_count: 1,
        status: 'ready' as const,
        ...fields,
      })),
    )
    .execute();
  const roster = () => request(ctx.app).get('/coach/students').set(auth(ctx.coachToken));
  queries.length = 0;
  const first = await roster();
  expect(first.status).toBe(200);
  expect(first.body.students[0].pending_video_count).toBe(2);
  const queryCount = queries.length;
  const students = Array.from(
    { length: 49 },
    (_, i) => `10000000-0000-4000-8000-${String(i + 100).padStart(12, '0')}`,
  );
  await ctx.db
    .insertInto('users')
    .values(
      students.map((id) => ({
        id,
        phone: `+8613${id.slice(-9)}`,
        password_hash: 'hash',
        role: 'coached_student' as const,
      })),
    )
    .execute();
  await ctx.db
    .insertInto('bind_requests')
    .values(
      students.map((student_id) => ({
        student_id,
        coach_id: ids.coach,
        status: 'accepted' as const,
        expired_at: new Date(),
      })),
    )
    .execute();
  queries.length = 0;
  const many = await roster();
  expect(many.status).toBe(200);
  expect(many.body.students).toHaveLength(50);
  expect(queries).toHaveLength(queryCount);
  expect(queryCount).toBe(6);
  expect(
    many.body.students.filter(
      (student: { pending_video_count: number }) => student.pending_video_count === 0,
    ),
  ).toHaveLength(49);
});

describe('ended coach permissions', () => {
  it('allows historical coach reads and still isolates unrelated coaches', async () => {
    const ctx = await makeContext();
    await request(ctx.app).post(`/coach/students/${ids.trainee}/unbind`).set(auth(ctx.coachToken));
    for (const path of [
      `/coach/students/${ids.trainee}/exercise-stats`,
      `/students/${ids.trainee}/videos`,
      `/students/${ids.trainee}/readiness?date=2026-11-02`,
    ]) {
      expect((await request(ctx.app).get(path).set(auth(ctx.coachToken))).status, path).toBe(200);
    }
    expect(
      (
        await request(ctx.app)
          .get(`/coach/students/${ids.otherStudent}/exercise-stats`)
          .set(auth(ctx.coachToken))
      ).status,
    ).toBe(403);
  });

  it('rejects ended coaches mutating an owned plan', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await request(ctx.app).post(`/coach/students/${ids.trainee}/unbind`).set(auth(ctx.coachToken));
    const res = await request(ctx.app)
      .patch(`/plans/${plan.planId}`)
      .set(auth(ctx.coachToken))
      .send({ name: '不可修改' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });
    expect(
      (await request(ctx.app).get(`/plans/${plan.planId}`).set(auth(ctx.coachToken))).status,
    ).toBe(200);
  });

  it('keeps chat sending forbidden after unbind', async () => {
    const ctx = await makeContext();
    await ctx.db.deleteFrom('bind_requests').where('coach_id', '=', ids.otherCoach).execute();
    const conversation = await request(ctx.app)
      .post('/conversations')
      .set(auth(ctx.coachToken))
      .send({ other_user_id: ids.trainee });
    expect(conversation.status).toBe(201);
    await request(ctx.app).post(`/coach/students/${ids.trainee}/unbind`).set(auth(ctx.coachToken));
    const sent = await request(ctx.app)
      .post(`/conversations/${String(conversation.body.conversation.id)}/messages`)
      .set(auth(ctx.coachToken))
      .send({ kind: 'text', body: '不能发送', client_id: '057-ended' });
    expect(sent.status).toBe(403);
    expect(sent.body.error).toBe('CHAT_BIND_REQUIRED');
  });
});

it('never exposes the ended enum through the admin binding serializer', async () => {
  const ctx = await makeContext();
  await request(ctx.app).post(`/coach/students/${ids.trainee}/unbind`).set(auth(ctx.coachToken));
  await ctx.db
    .updateTable('users')
    .set({ role: 'admin' })
    .where('id', '=', ids.otherCoach)
    .execute();
  const res = await request(ctx.app)
    .get('/admin/bindings')
    .set(auth(signToken(ids.otherCoach, 'admin')));
  expect(res.status).toBe(200);
  const binding = res.body.bindings.find((row: { coachId: string }) => row.coachId === ids.coach);
  expect(binding).toMatchObject({ status: 'cancelled', ended_at: expect.any(String) });
  expect(res.body.bindings.some((row: { status: string }) => row.status === 'ended')).toBe(false);
});

it('retains the private alias through a real new application and acceptance', async () => {
  const ctx = await makeContext();
  for (const path of [
    'db/migrations/0008-init-invite-codes.sql',
    'db/migrations/0009-extend-bind-requests.sql',
  ]) {
    await sql.raw(fs.readFileSync(path, 'utf8')).execute(ctx.db);
  }
  // pg-mem can incorrectly use the pending partial index for accepted rows;
  // bindEval also omits this index, whose constraint has a migration test.
  await sql`DROP INDEX bind_requests_unique_pending`.execute(ctx.db);
  const alias = await request(ctx.app)
    .patch(`/coach/students/${ids.trainee}`)
    .set(auth(ctx.coachToken))
    .send({ alias: '回归学员' });
  expect(alias.status).toBe(200);
  expect(
    (await request(ctx.app).post(`/coach/students/${ids.trainee}/unbind`).set(auth(ctx.coachToken)))
      .status,
  ).toBe(200);
  const code = await request(ctx.app)
    .post('/coach/invite-codes')
    .set(auth(ctx.coachToken))
    .send({ type: 'personal_permanent' });
  expect(code.status).toBe(201);
  const applied = await request(ctx.app)
    .post('/bind-requests')
    .set(auth(ctx.traineeToken))
    .send({ code: code.body.code, display_name: 'Trainee One' });
  expect(applied.status).toBe(201);
  expect(applied.body).toMatchObject({ status: 'pending', ended_at: null });
  const accepted = await request(ctx.app)
    .post(`/coach/bind-requests/${String(applied.body.id)}/accept`)
    .set(auth(ctx.coachToken))
    .send({ skip_evaluation: true });
  expect(accepted.status).toBe(200);
  const roster = await request(ctx.app)
    .get('/coach/students?include_ended=1')
    .set(auth(ctx.coachToken));
  expect(roster.body.students).toHaveLength(1);
  expect(roster.body.students[0]).toMatchObject({
    alias: '回归学员',
    display_name: 'Trainee One',
    bond_status: 'active',
    ended_at: null,
  });
});

it('keeps role, identity and validation gates on unbind', async () => {
  const ctx = await makeContext();
  const url = `/coach/students/${ids.trainee}/unbind`;
  expect((await request(ctx.app).post(url)).status).toBe(401);
  expect((await request(ctx.app).post(url).set(auth(ctx.traineeToken))).status).toBe(403);
  expect(
    (
      await request(ctx.app)
        .post(`/coach/students/${ids.otherStudent}/unbind`)
        .set(auth(ctx.coachToken))
    ).body,
  ).toEqual({ error: 'COACH_STUDENT_NOT_FOUND' });
  expect(
    (await request(ctx.app).post('/coach/students/not-a-uuid/unbind').set(auth(ctx.coachToken)))
      .status,
  ).toBe(400);
  expect((await request(ctx.app).post(url).set(auth(ctx.coachToken))).status).toBe(200);
  expect(await ctx.db.selectFrom('notification_outbox').selectAll().execute()).toEqual([]);
  expect(
    await ctx.db
      .selectFrom('bind_requests')
      .select('status')
      .where('coach_id', '=', ids.otherCoach)
      .executeTakeFirstOrThrow(),
  ).toEqual({ status: 'accepted' });
});

it('blocks nested plan mutations and video viewed writes for an ended coach', async () => {
  const ctx = await makeContext();
  const plan = await createPublishedPlan(ctx);
  const set = await ctx.db
    .selectFrom('plan_sets')
    .select('id')
    .where('plan_exercise_id', '=', plan.planExerciseId)
    .executeTakeFirstOrThrow();
  const video = await ctx.db
    .insertInto('attachments')
    .values({
      owner_id: ids.trainee,
      kind: 'set_video',
      oss_key: '057-history-video',
      source_coach_id: ids.coach,
      status: 'ready',
      content_type: 'video/mp4',
      size_bytes: 100,
      part_count: 1,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await request(ctx.app).post(`/coach/students/${ids.trainee}/unbind`).set(auth(ctx.coachToken));
  for (const path of [
    `/plans/${plan.planId}`,
    `/plans/${plan.planId}/pending-revision`,
    `/plans/${plan.planId}/shift`,
    `/plans/days/${plan.dayId}`,
    `/plans/exercises/${plan.planExerciseId}`,
    `/plans/sets/${set.id}`,
  ]) {
    expect((await request(ctx.app).delete(path).set(auth(ctx.coachToken))).status, path).toBe(403);
  }
  const viewed = await request(ctx.app)
    .post(`/videos/${video.id}/viewed`)
    .set(auth(ctx.coachToken));
  expect(viewed.status).toBe(403);
  expect(
    (await request(ctx.app).get(`/videos/${video.id}/markers`).set(auth(ctx.coachToken))).status,
  ).toBe(200);
});

it('rejects acknowledging an ended student signal without changing it', async () => {
  const ctx = await makeContext();
  const signal = await ctx.db
    .insertInto('student_signals')
    .values({
      student_id: ids.trainee,
      coach_id: ids.coach,
      signal_type: 'missed_training',
      severity: 'red',
      status: 'open',
      reason: 'missing training',
      payload: '{}',
      opened_at: new Date(),
      expires_at: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const unbound = await request(ctx.app)
    .post(`/coach/students/${ids.trainee}/unbind`)
    .set(auth(ctx.coachToken));
  expect(unbound.status).toBe(200);
  const response = await request(ctx.app)
    .post(`/coach/signals/${signal.id}/ack`)
    .set(auth(ctx.coachToken));
  expect(response.status).toBe(403);
  expect(response.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });
  const after = await ctx.db
    .selectFrom('student_signals')
    .select(['status', 'acked_at'])
    .where('id', '=', signal.id)
    .executeTakeFirstOrThrow();
  expect(after).toEqual({ status: 'open', acked_at: null });
});

it.each([true, false])(
  'can rebind with a new evaluation after unbind (old open evaluation=%s)',
  async (hasOpenEvaluation) => {
    const ctx = await makeContext();
    for (const path of [
      'db/migrations/0008-init-invite-codes.sql',
      'db/migrations/0009-extend-bind-requests.sql',
    ]) {
      await sql.raw(fs.readFileSync(path, 'utf8')).execute(ctx.db);
    }
    await sql`DROP INDEX bind_requests_unique_pending`.execute(ctx.db);
    await sql`CREATE UNIQUE INDEX evaluation_periods_one_active ON evaluation_periods (student_id, coach_id) WHERE completed_at IS NULL`.execute(
      ctx.db,
    );
    const bonds = await ctx.db
      .selectFrom('bind_requests')
      .select(['id', 'coach_id'])
      .where('student_id', '=', ids.trainee)
      .execute();
    const ownBond = bonds.find((bond) => bond.coach_id === ids.coach);
    const otherBond = bonds.find((bond) => bond.coach_id === ids.otherCoach);
    if (!ownBond || !otherBond) throw new Error('Expected accepted bonds for both coaches');
    const old = hasOpenEvaluation
      ? await ctx.db
          .insertInto('evaluation_periods')
          .values({
            student_id: ids.trainee,
            coach_id: ids.coach,
            bind_request_id: ownBond.id,
            expected_end_at: new Date(),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      : null;
    const unrelated = await ctx.db
      .insertInto('evaluation_periods')
      .values({
        student_id: ids.trainee,
        coach_id: ids.otherCoach,
        bind_request_id: otherBond.id,
        expected_end_at: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const unbind = () =>
      request(ctx.app).post(`/coach/students/${ids.trainee}/unbind`).set(auth(ctx.coachToken));
    expect((await unbind()).status).toBe(200);
    expect((await unbind()).status).toBe(404);
    const code = await request(ctx.app)
      .post('/coach/invite-codes')
      .set(auth(ctx.coachToken))
      .send({ type: 'personal_permanent' });
    expect(code.status).toBe(201);
    const applied = await request(ctx.app)
      .post('/bind-requests')
      .set(auth(ctx.traineeToken))
      .send({ code: code.body.code, display_name: 'Trainee One' });
    expect(applied.status).toBe(201);
    const accepted = await request(ctx.app)
      .post(`/coach/bind-requests/${String(applied.body.id)}/accept`)
      .set(auth(ctx.coachToken))
      .send({ skip_evaluation: false });
    expect(accepted.status).toBe(200);
    expect(accepted.body.evaluation_period).toMatchObject({
      bind_request_id: applied.body.id,
      completed_at: null,
      completion_type: null,
    });
    if (old) {
      expect(accepted.body.evaluation_period.id).not.toBe(old.id);
      const retained = await ctx.db
        .selectFrom('evaluation_periods')
        .select(['bind_request_id', 'completed_at', 'completion_type'])
        .where('id', '=', old.id)
        .executeTakeFirstOrThrow();
      const ended = await ctx.db
        .selectFrom('bind_requests')
        .select('ended_at')
        .where('id', '=', ownBond.id)
        .executeTakeFirstOrThrow();
      expect(retained).toEqual({
        bind_request_id: ownBond.id,
        completed_at: ended.ended_at,
        completion_type: 'cancelled',
      });
    }
    expect(
      await ctx.db
        .selectFrom('evaluation_periods')
        .select(['completed_at', 'completion_type'])
        .where('id', '=', unrelated.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ completed_at: null, completion_type: null });
  },
);

it('bounds roster calendar rows to published plans and recent completions despite growing history', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-02T15:00:00Z'));
  const queries: { sql: string; rows: number }[] = [];
  const ctx = await makeContext(undefined, {
    afterQuery: (sql, rows) => {
      queries.push({ sql, rows });
      return Promise.resolve();
    },
  });
  const current = await createPublishedPlan(ctx);
  await ctx.db
    .insertInto('plan_day_shifts')
    .values({
      plan_day_id: current.dayId,
      student_id: ids.trainee,
      batch_id: '90000000-0000-4000-8000-000000000057',
      shifted_to_date: '2026-11-02',
    })
    .execute();
  await ctx.db
    .insertInto('plan_day_completions')
    .values({
      plan_day_id: current.dayId,
      student_id: ids.trainee,
      source: 'manual',
      completed_at: new Date('2026-11-02T14:00:00Z'),
    })
    .execute();
  for (const status of [
    'draft',
    'paused',
    'completed',
    'draft',
    'paused',
    'completed',
    'completed',
  ] as const) {
    const history = await createPublishedPlan(ctx);
    await ctx.db.updateTable('plans').set({ status }).where('id', '=', history.planId).execute();
    await ctx.db
      .insertInto('plan_day_shifts')
      .values({
        plan_day_id: history.dayId,
        student_id: ids.trainee,
        batch_id: history.planId,
        shifted_to_date: '2026-11-02',
      })
      .execute();
    await ctx.db
      .insertInto('plan_day_completions')
      .values({
        plan_day_id: history.dayId,
        student_id: ids.trainee,
        source: 'manual',
        completed_at: new Date('2026-09-01T00:00:00Z'),
      })
      .execute();
  }
  // A plan completed today is no longer published, but its completion still counts.
  const recent = await createPublishedPlan(ctx);
  await ctx.db
    .updateTable('plans')
    .set({ status: 'completed' })
    .where('id', '=', recent.planId)
    .execute();
  await ctx.db
    .insertInto('plan_day_completions')
    .values({
      plan_day_id: recent.dayId,
      student_id: ids.trainee,
      source: 'manual',
      completed_at: new Date('2026-11-02T13:00:00Z'),
    })
    .execute();
  queries.length = 0;
  const roster = await request(ctx.app).get('/coach/students').set(auth(ctx.coachToken));
  expect(roster.status).toBe(200);
  expect(roster.body.students[0].today).toEqual({
    state: 'completed',
    completed_at: '2026-11-02T13:00:00.000Z',
  });
  expect(queries).toHaveLength(6);
  const calendarRows = Object.fromEntries(
    queries.flatMap(({ sql, rows }) => {
      const table = /from "(plans|plan_days|plan_day_shifts|plan_day_completions)"/.exec(sql)?.[1];
      return table ? [[table, rows]] : [];
    }),
  );
  expect(calendarRows).toEqual({
    plans: 1,
    plan_days: 1,
    plan_day_shifts: 1,
    plan_day_completions: 2,
  });
});
