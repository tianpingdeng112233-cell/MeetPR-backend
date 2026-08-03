import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { auth, ids, makeContext, type TestContext } from './helpers/bindEval';

async function makeCode(
  ctx: TestContext,
  body: Record<string, unknown> = { type: 'personal_permanent' },
): Promise<string> {
  const response = await request(ctx.app)
    .post('/coach/invite-codes')
    .set(auth(ctx.coachToken))
    .send(body);
  return response.body.code as string;
}

describe('student bind requests', () => {
  it('enqueues bind_request for the invite-code coach after creation', async () => {
    const ctx = await makeContext(undefined, { PUSH_ENABLED: true });
    const code = await makeCode(ctx);

    const created = await request(ctx.app)
      .post('/bind-requests')
      .set(auth(ctx.freeStudentToken))
      .send({ code, display_name: '陈某' });

    expect(created.status).toBe(201);
    const row = await ctx.db
      .selectFrom('notification_outbox')
      .selectAll()
      .where('event_type', '=', 'bind_request')
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      aggregate_id: created.body.id,
      recipient_id: ids.coach,
      status: 'pending',
    });
    expect(row.payload).toEqual({ student_name: '陈某', request_id: created.body.id });
  });

  it('creates a pending request, bootstraps the student profile, and shows up in the roster after accept', async () => {
    const ctx = await makeContext();
    const code = await makeCode(ctx);

    const created = await request(ctx.app)
      .post('/bind-requests')
      .set(auth(ctx.freeStudentToken))
      .send({ code, display_name: '张三' });

    expect(created.status).toBe(201);
    expect(created.body.status).toBe('pending');
    expect(created.body.coach_id).toBe(ids.coach);
    expect(created.body.coach_display_name).toBe('Coach A');
    expect(created.body.invite_code_id).not.toBeNull();
    expect(created.body.expired_at > created.body.submitted_at).toBe(true);

    // display_name bootstrap (D1): profile row now exists.
    const profile = await ctx.db
      .selectFrom('student_profiles')
      .selectAll()
      .where('user_id', '=', ids.freeStudent)
      .executeTakeFirst();
    expect(profile?.display_name).toBe('张三');

    // After accept the student appears in the coach roster (inner join survives).
    const createdId = created.body.id as string;
    const accept = await request(ctx.app)
      .post(`/coach/bind-requests/${createdId}/accept`)
      .set(auth(ctx.coachToken))
      .send({ skip_evaluation: true });
    expect(accept.status).toBe(200);

    const roster = await request(ctx.app).get('/coach/students').set(auth(ctx.coachToken));
    const rosterIds = roster.body.students.map((s: { id: string }) => s.id);
    expect(rosterIds).toContain(ids.freeStudent);
  });

  it('re-binding updates the existing profile display_name', async () => {
    const ctx = await makeContext();
    const code = await makeCode(ctx);

    // boundStudent already has a profile row + accepted bond with coach; use
    // otherCoach to avoid the already-bound guard.
    const otherCode = await request(ctx.app)
      .post('/coach/invite-codes')
      .set(auth(ctx.otherCoachToken))
      .send({ type: 'personal_permanent' });

    const created = await request(ctx.app)
      .post('/bind-requests')
      .set(auth(ctx.boundStudentToken))
      .send({ code: otherCode.body.code, display_name: 'Renamed Student' });
    expect(created.status).toBe(201);

    const profile = await ctx.db
      .selectFrom('student_profiles')
      .selectAll()
      .where('user_id', '=', ids.boundStudent)
      .executeTakeFirst();
    expect(profile?.display_name).toBe('Renamed Student');
    expect(code).toHaveLength(10);
  });

  it('rejects invalid, revoked, exhausted, and expired codes uniformly', async () => {
    const ctx = await makeContext();

    const unknown = await request(ctx.app)
      .post('/bind-requests')
      .set(auth(ctx.freeStudentToken))
      .send({ code: 'ZZZZZZZZZZ', display_name: '张三' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe('INVITE_CODE_INVALID');

    // Revoked code
    const revoked = await request(ctx.app)
      .post('/coach/invite-codes')
      .set(auth(ctx.coachToken))
      .send({ type: 'single_use' });
    await request(ctx.app)
      .delete(`/coach/invite-codes/${revoked.body.id as string}`)
      .set(auth(ctx.coachToken));
    const useRevoked = await request(ctx.app)
      .post('/bind-requests')
      .set(auth(ctx.freeStudentToken))
      .send({ code: revoked.body.code, display_name: '张三' });
    expect(useRevoked.status).toBe(400);
    expect(useRevoked.body.error).toBe('INVITE_CODE_INVALID');

    // Exhausted single_use: drain it with one student, then retry with another.
    const single = await makeCode(ctx, { type: 'single_use' });
    const firstUse = await request(ctx.app)
      .post('/bind-requests')
      .set(auth(ctx.freeStudentToken))
      .send({ code: single, display_name: '张三' });
    expect(firstUse.status).toBe(201);
    // Cancel so the student could re-request; the code stays exhausted.
    await request(ctx.app)
      .delete(`/bind-requests/${firstUse.body.id as string}`)
      .set(auth(ctx.freeStudentToken));
    const secondUse = await request(ctx.app)
      .post('/bind-requests')
      .set(auth(ctx.freeStudentToken))
      .send({ code: single, display_name: '张三' });
    expect(secondUse.status).toBe(400);
    expect(secondUse.body.error).toBe('INVITE_CODE_INVALID');

    // Expired time_limited code (force expires_at into the past).
    const timed = await request(ctx.app)
      .post('/coach/invite-codes')
      .set(auth(ctx.coachToken))
      .send({ type: 'time_limited', expires_in_days: 1 });
    await ctx.db
      .updateTable('invite_codes')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('id', '=', timed.body.id)
      .execute();
    const useTimed = await request(ctx.app)
      .post('/bind-requests')
      .set(auth(ctx.freeStudentToken))
      .send({ code: timed.body.code, display_name: '张三' });
    expect(useTimed.status).toBe(400);
    expect(useTimed.body.error).toBe('INVITE_CODE_INVALID');
  });

  it('normalizes lowercase code input', async () => {
    const ctx = await makeContext();
    const code = await makeCode(ctx);

    const created = await request(ctx.app)
      .post('/bind-requests')
      .set(auth(ctx.freeStudentToken))
      .send({ code: code.toLowerCase(), display_name: '张三' });
    expect(created.status).toBe(201);
  });

  it('blocks a second concurrent pending request', async () => {
    const ctx = await makeContext();
    const code = await makeCode(ctx);

    const first = await request(ctx.app)
      .post('/bind-requests')
      .set(auth(ctx.freeStudentToken))
      .send({ code, display_name: '张三' });
    expect(first.status).toBe(201);

    const second = await request(ctx.app)
      .post('/bind-requests')
      .set(auth(ctx.freeStudentToken))
      .send({ code, display_name: '张三' });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('BIND_REQUEST_ALREADY_PENDING');
  });

  it('blocks re-binding an already accepted pair and rolls back the use count', async () => {
    const ctx = await makeContext();
    const code = await makeCode(ctx);

    // boundStudent ←→ coach is already accepted in the fixture.
    const response = await request(ctx.app)
      .post('/bind-requests')
      .set(auth(ctx.boundStudentToken))
      .send({ code, display_name: 'Bound Student' });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('BIND_ALREADY_BOUND');

    const inviteCode = await ctx.db
      .selectFrom('invite_codes')
      .select(['used_count'])
      .where('code', '=', code)
      .executeTakeFirstOrThrow();
    expect(inviteCode.used_count).toBe(0);
  });

  it('GET /bind-requests/mine returns the latest request and lazily expires stale pendings', async () => {
    const ctx = await makeContext();
    const code = await makeCode(ctx);

    const empty = await request(ctx.app).get('/bind-requests/mine').set(auth(ctx.freeStudentToken));
    expect(empty.status).toBe(200);
    expect(empty.body.bind_request).toBeNull();

    const created = await request(ctx.app)
      .post('/bind-requests')
      .set(auth(ctx.freeStudentToken))
      .send({ code, display_name: '张三' });

    // Force the pending request past its expiry.
    await ctx.db
      .updateTable('bind_requests')
      .set({ expired_at: new Date(Date.now() - 1000) })
      .where('id', '=', created.body.id)
      .execute();

    const mine = await request(ctx.app).get('/bind-requests/mine').set(auth(ctx.freeStudentToken));
    expect(mine.status).toBe(200);
    expect(mine.body.bind_request.id).toBe(created.body.id);
    expect(mine.body.bind_request.status).toBe('expired');
    expect(mine.body.bind_request.coach_display_name).toBe('Coach A');
  });

  it('cancels own pending request; blocks foreign and non-pending cancellation', async () => {
    const ctx = await makeContext();
    const code = await makeCode(ctx);

    const created = await request(ctx.app)
      .post('/bind-requests')
      .set(auth(ctx.freeStudentToken))
      .send({ code, display_name: '张三' });

    const createdId = created.body.id as string;
    const foreign = await request(ctx.app)
      .delete(`/bind-requests/${createdId}`)
      .set(auth(ctx.boundStudentToken));
    expect(foreign.status).toBe(404);
    expect(foreign.body.error).toBe('BIND_REQUEST_NOT_FOUND');

    const cancelled = await request(ctx.app)
      .delete(`/bind-requests/${createdId}`)
      .set(auth(ctx.freeStudentToken));
    expect(cancelled.status).toBe(204);

    const again = await request(ctx.app)
      .delete(`/bind-requests/${createdId}`)
      .set(auth(ctx.freeStudentToken));
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('BIND_REQUEST_NOT_PENDING');

    const row = await ctx.db
      .selectFrom('bind_requests')
      .select(['status', 'responded_at'])
      .where('id', '=', created.body.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('cancelled');
    expect(row.responded_at).toBeNull();
  });

  it('rejects coach and self_train roles on student endpoints and camelCase input', async () => {
    const ctx = await makeContext();
    const code = await makeCode(ctx);

    const asCoach = await request(ctx.app)
      .post('/bind-requests')
      .set(auth(ctx.coachToken))
      .send({ code, display_name: 'X' });
    const asSelfTrain = await request(ctx.app)
      .post('/bind-requests')
      .set(auth(ctx.selfTrainStudentToken))
      .send({ code, display_name: 'X' });
    const camel = await request(ctx.app)
      .post('/bind-requests')
      .set(auth(ctx.freeStudentToken))
      .send({ code, displayName: 'X' });

    expect(asCoach.status).toBe(403);
    expect(asSelfTrain.status).toBe(403);
    expect(camel.status).toBe(400);
    expect(camel.body.error).toBe('VALIDATION_ERROR');
  });
});
