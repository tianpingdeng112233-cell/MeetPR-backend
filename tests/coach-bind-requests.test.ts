import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { auth, ids, makeContext, type TestContext } from './helpers/bindEval';

async function createPendingRequest(ctx: TestContext): Promise<string> {
  const code = await request(ctx.app)
    .post('/coach/invite-codes')
    .set(auth(ctx.coachToken))
    .send({ type: 'personal_permanent' });
  const created = await request(ctx.app)
    .post('/bind-requests')
    .set(auth(ctx.freeStudentToken))
    .send({ code: code.body.code, display_name: '张三' });
  return created.body.id as string;
}

describe('coach bind request queue', () => {
  it('lists pending requests with an empty backward-compatible onboarding summary', async () => {
    const ctx = await makeContext();
    await ctx.db
      .updateTable('users')
      .set({ phone: '+8613800000171' })
      .where('id', '=', ids.freeStudent)
      .execute();
    const requestId = await createPendingRequest(ctx);
    const inviteCode = await ctx.db
      .selectFrom('bind_requests as br')
      .innerJoin('invite_codes as ic', 'ic.id', 'br.invite_code_id')
      .select('ic.code')
      .where('br.id', '=', requestId)
      .executeTakeFirstOrThrow();

    const queue = await request(ctx.app).get('/coach/bind-requests').set(auth(ctx.coachToken));
    expect(queue.status).toBe(200);
    expect(queue.body.bind_requests).toHaveLength(1);

    const item = queue.body.bind_requests[0];
    expect(item.id).toBe(requestId);
    expect(item.student_id).toBe(ids.freeStudent);
    expect(item.display_name).toBe('张三');
    expect(item.masked_phone).toBe('138****0171');
    expect(item.invite_code).toBe(inviteCode.code);
    expect(item.onboarding).toEqual({
      completed: false,
      gender: null,
      birth_date: null,
      height_cm: null,
      weight_kg: null,
      training_years: null,
      squat_1rm_kg: null,
      bench_1rm_kg: null,
      deadlift_1rm_kg: null,
      squat_stance: null,
      deadlift_style: null,
      bench_grip: null,
      training_days: null,
      injury_notes: null,
      injury_areas: null,
      muscle_groups_to_strengthen: null,
      gym_tier: null,
      is_competing: null,
      competition_date: null,
      target_weight_class: null,
      note_to_coach: null,
      upload_count: 0,
    });
  });

  it('includes the plan-web onboarding snapshot while retaining the iOS summary fields', async () => {
    const ctx = await makeContext();
    await createPendingRequest(ctx);

    const put = await request(ctx.app)
      .put('/students/me/onboarding')
      .set(auth(ctx.freeStudentToken))
      .send({
        gender: 'male',
        birth_date: '2001-03-12',
        height_cm: '178',
        weight_kg: '83',
        training_years: 3,
        squat_1rm_kg: '180',
        bench_1rm_kg: '120',
        deadlift_1rm_kg: '220',
        squat_stance: 'low_bar',
        deadlift_style: 'conventional',
        bench_grip: 'standard',
        training_days: ['mon', 'wed', 'fri'],
        injury_notes: '右肩注意热身',
        injury_areas: ['shoulder'],
        muscle_groups_to_strengthen: ['quad', 'hamstring', 'shoulder'],
        gym_tier: 'commercial',
        is_competing: true,
        competition_date: '2026-07-25',
        target_weight_class: 'IPF 83kg',
        note_to_coach: '想突破 200kg 深蹲',
        upload_attachment_ids: [
          '90000000-0000-4000-8000-000000000001',
          '90000000-0000-4000-8000-000000000002',
        ],
      });
    expect(put.status).toBe(200);

    const queue = await request(ctx.app).get('/coach/bind-requests').set(auth(ctx.coachToken));
    const onboarding = queue.body.bind_requests[0].onboarding;
    expect(onboarding.completed).toBe(false); // not yet POST /complete
    expect(onboarding.gender).toBe('male');
    expect(onboarding.birth_date).toBe('2001-03-12');
    expect(onboarding.height_cm).toBe('178.0');
    expect(onboarding.weight_kg).toBe('83.00');
    expect(onboarding.training_years).toBe(3);
    expect(onboarding.squat_1rm_kg).toBe('180.00');
    expect(onboarding.bench_1rm_kg).toBe('120.00');
    expect(onboarding.deadlift_1rm_kg).toBe('220.00');
    expect(onboarding.squat_stance).toBe('low_bar');
    expect(onboarding.deadlift_style).toBe('conventional');
    expect(onboarding.bench_grip).toBe('standard');
    expect(onboarding.training_days).toEqual(['mon', 'wed', 'fri']);
    expect(onboarding.injury_notes).toBe('右肩注意热身');
    expect(onboarding.injury_areas).toEqual(['shoulder']);
    expect(onboarding.muscle_groups_to_strengthen).toEqual(['quad', 'hamstring', 'shoulder']);
    expect(onboarding.gym_tier).toBe('commercial');
    expect(onboarding.is_competing).toBe(true);
    expect(onboarding.competition_date).toBe('2026-07-25');
    expect(onboarding.target_weight_class).toBe('IPF 83kg');
    expect(onboarding.note_to_coach).toBe('想突破 200kg 深蹲');
    expect(onboarding.upload_count).toBe(2);
  });

  it('lazily expires stale pendings out of the queue', async () => {
    const ctx = await makeContext();
    const requestId = await createPendingRequest(ctx);

    await ctx.db
      .updateTable('bind_requests')
      .set({ expired_at: new Date(Date.now() - 1000) })
      .where('id', '=', requestId)
      .execute();

    const queue = await request(ctx.app).get('/coach/bind-requests').set(auth(ctx.coachToken));
    expect(queue.body.bind_requests).toHaveLength(0);

    const row = await ctx.db
      .selectFrom('bind_requests')
      .select(['status'])
      .where('id', '=', requestId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('expired');
  });

  it('accept with evaluation creates a 7-day evaluation period', async () => {
    const ctx = await makeContext();
    const requestId = await createPendingRequest(ctx);

    const accept = await request(ctx.app)
      .post(`/coach/bind-requests/${requestId}/accept`)
      .set(auth(ctx.coachToken))
      .send({ skip_evaluation: false });

    expect(accept.status).toBe(200);
    expect(accept.body.bind_request.status).toBe('accepted');
    expect(accept.body.bind_request.responded_at).not.toBeNull();
    expect(accept.body.bind_request.skip_evaluation).toBe(false);
    expect(accept.body.evaluation_period).not.toBeNull();
    expect(accept.body.evaluation_period.student_id).toBe(ids.freeStudent);
    expect(accept.body.evaluation_period.coach_id).toBe(ids.coach);
    expect(accept.body.evaluation_period.bind_request_id).toBe(requestId);
    expect(accept.body.evaluation_period.in_progress).toBe(true);
    expect(accept.body.evaluation_period.overdue).toBe(false);

    const startedAt = new Date(accept.body.evaluation_period.started_at).getTime();
    const expectedEnd = new Date(accept.body.evaluation_period.expected_end_at).getTime();
    expect(expectedEnd - startedAt).toBeCloseTo(7 * 24 * 3600 * 1000, -4);
  });

  it('accept with skip_evaluation records the reason and creates no evaluation period', async () => {
    const ctx = await makeContext();
    const requestId = await createPendingRequest(ctx);

    const accept = await request(ctx.app)
      .post(`/coach/bind-requests/${requestId}/accept`)
      .set(auth(ctx.coachToken))
      .send({ skip_evaluation: true, skip_reason: '已带过的学员' });

    expect(accept.status).toBe(200);
    expect(accept.body.bind_request.skip_evaluation).toBe(true);
    expect(accept.body.bind_request.skip_reason).toBe('已带过的学员');
    expect(accept.body.evaluation_period).toBeNull();

    const periods = await ctx.db.selectFrom('evaluation_periods').selectAll().execute();
    expect(periods).toHaveLength(0);
  });

  it('rejects skip_reason without skip_evaluation', async () => {
    const ctx = await makeContext();
    const requestId = await createPendingRequest(ctx);

    const response = await request(ctx.app)
      .post(`/coach/bind-requests/${requestId}/accept`)
      .set(auth(ctx.coachToken))
      .send({ skip_evaluation: false, skip_reason: 'nope' });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('VALIDATION_ERROR');
  });

  it('reject is silent and final; re-responding conflicts', async () => {
    const ctx = await makeContext();
    const requestId = await createPendingRequest(ctx);

    const reject = await request(ctx.app)
      .post(`/coach/bind-requests/${requestId}/reject`)
      .set(auth(ctx.coachToken))
      .send({});
    expect(reject.status).toBe(200);
    expect(reject.body.bind_request.status).toBe('rejected');
    expect(reject.body.bind_request.responded_at).not.toBeNull();

    const accept = await request(ctx.app)
      .post(`/coach/bind-requests/${requestId}/accept`)
      .set(auth(ctx.coachToken))
      .send({ skip_evaluation: true });
    expect(accept.status).toBe(409);
    expect(accept.body.error).toBe('BIND_REQUEST_NOT_PENDING');
  });

  it('accept after a student cancel loses cleanly (conditional transition)', async () => {
    const ctx = await makeContext();
    const bindRequestId = await createPendingRequest(ctx);

    const cancel = await request(ctx.app)
      .delete(`/bind-requests/${bindRequestId}`)
      .set(auth(ctx.freeStudentToken));
    expect(cancel.status).toBe(204);

    const accept = await request(ctx.app)
      .post(`/coach/bind-requests/${bindRequestId}/accept`)
      .set(auth(ctx.coachToken))
      .send({ skip_evaluation: false });

    expect(accept.status).toBe(409);
    expect(accept.body).toEqual({ error: 'BIND_REQUEST_NOT_PENDING' });
    const row = await ctx.db
      .selectFrom('bind_requests')
      .select(['status'])
      .where('id', '=', bindRequestId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('cancelled');
    const periods = await ctx.db.selectFrom('evaluation_periods').selectAll().execute();
    expect(periods).toHaveLength(0);
  });

  it('hides other coaches requests and expires stale ones on the mutation path', async () => {
    const ctx = await makeContext();
    const requestId = await createPendingRequest(ctx);

    const foreign = await request(ctx.app)
      .post(`/coach/bind-requests/${requestId}/accept`)
      .set(auth(ctx.otherCoachToken))
      .send({ skip_evaluation: true });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error).toBe('BIND_REQUEST_NOT_FOUND');

    await ctx.db
      .updateTable('bind_requests')
      .set({ expired_at: new Date(Date.now() - 1000) })
      .where('id', '=', requestId)
      .execute();

    const expired = await request(ctx.app)
      .post(`/coach/bind-requests/${requestId}/accept`)
      .set(auth(ctx.coachToken))
      .send({ skip_evaluation: true });
    expect(expired.status).toBe(409);
    expect(expired.body.error).toBe('BIND_REQUEST_EXPIRED');

    const row = await ctx.db
      .selectFrom('bind_requests')
      .select(['status'])
      .where('id', '=', requestId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('expired');
  });

  it('requires the coach role on queue endpoints', async () => {
    const ctx = await makeContext();

    const queue = await request(ctx.app)
      .get('/coach/bind-requests')
      .set(auth(ctx.freeStudentToken));
    expect(queue.status).toBe(403);
  });
});
