import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { auth, ids, makeContext } from './helpers/bindEval';

describe('coach invite codes', () => {
  it('creates a personal permanent code and auto-revokes the previous active one', async () => {
    const ctx = await makeContext();

    const first = await request(ctx.app)
      .post('/coach/invite-codes')
      .set(auth(ctx.coachToken))
      .send({ type: 'personal_permanent' });
    const second = await request(ctx.app)
      .post('/coach/invite-codes')
      .set(auth(ctx.coachToken))
      .send({ type: 'personal_permanent' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.code).toHaveLength(10);
    expect(first.body.max_uses).toBeNull();
    expect(first.body.expires_at).toBeNull();

    const list = await request(ctx.app).get('/coach/invite-codes').set(auth(ctx.coachToken));
    expect(list.status).toBe(200);
    expect(list.body.invite_codes).toHaveLength(2);
    const active = list.body.invite_codes.filter(
      (code: { type: string; revoked_at: string | null }) =>
        code.type === 'personal_permanent' && code.revoked_at === null,
    );
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(second.body.id);
  });

  it('generates codes without ambiguous characters (I O 0 1)', async () => {
    const ctx = await makeContext();

    for (let i = 0; i < 5; i += 1) {
      const response = await request(ctx.app)
        .post('/coach/invite-codes')
        .set(auth(ctx.coachToken))
        .send({ type: 'single_use' });
      expect(response.status).toBe(201);
      expect(response.body.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/);
      expect(response.body.max_uses).toBe(1);
    }
  });

  it('requires expires_in_days for time_limited and rejects it elsewhere', async () => {
    const ctx = await makeContext();

    const missing = await request(ctx.app)
      .post('/coach/invite-codes')
      .set(auth(ctx.coachToken))
      .send({ type: 'time_limited' });
    const extra = await request(ctx.app)
      .post('/coach/invite-codes')
      .set(auth(ctx.coachToken))
      .send({ type: 'single_use', expires_in_days: 7 });
    const valid = await request(ctx.app)
      .post('/coach/invite-codes')
      .set(auth(ctx.coachToken))
      .send({ type: 'time_limited', expires_in_days: 7, label: '馆活动周' });

    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('VALIDATION_ERROR');
    expect(extra.status).toBe(400);
    expect(valid.status).toBe(201);
    expect(valid.body.expires_at).not.toBeNull();
    expect(valid.body.label).toBe('馆活动周');
  });

  it('revokes own codes idempotently and hides other coaches codes', async () => {
    const ctx = await makeContext();

    const created = await request(ctx.app)
      .post('/coach/invite-codes')
      .set(auth(ctx.coachToken))
      .send({ type: 'single_use' });
    const codeId = created.body.id as string;

    const revoke = await request(ctx.app)
      .delete(`/coach/invite-codes/${codeId}`)
      .set(auth(ctx.coachToken));
    const reRevoke = await request(ctx.app)
      .delete(`/coach/invite-codes/${codeId}`)
      .set(auth(ctx.coachToken));
    const foreign = await request(ctx.app)
      .delete(`/coach/invite-codes/${codeId}`)
      .set(auth(ctx.otherCoachToken));

    expect(revoke.status).toBe(204);
    expect(reRevoke.status).toBe(204);
    expect(foreign.status).toBe(404);
    expect(foreign.body.error).toBe('INVITE_CODE_NOT_FOUND');

    const list = await request(ctx.app).get('/coach/invite-codes').set(auth(ctx.coachToken));
    expect(list.body.invite_codes[0].revoked_at).not.toBeNull();
  });

  it('rejects non-coach roles', async () => {
    const ctx = await makeContext();

    const create = await request(ctx.app)
      .post('/coach/invite-codes')
      .set(auth(ctx.boundStudentToken))
      .send({ type: 'single_use' });
    const list = await request(ctx.app)
      .get('/coach/invite-codes')
      .set(auth(ctx.selfTrainStudentToken));

    expect(create.status).toBe(403);
    expect(list.status).toBe(403);
  });

  it('lists used_count reflecting successful bind requests', async () => {
    const ctx = await makeContext();

    const created = await request(ctx.app)
      .post('/coach/invite-codes')
      .set(auth(ctx.coachToken))
      .send({ type: 'personal_permanent' });

    const bind = await request(ctx.app)
      .post('/bind-requests')
      .set(auth(ctx.freeStudentToken))
      .send({ code: created.body.code, display_name: '张三' });
    expect(bind.status).toBe(201);

    const list = await request(ctx.app).get('/coach/invite-codes').set(auth(ctx.coachToken));
    const code = list.body.invite_codes.find((c: { id: string }) => c.id === created.body.id);
    expect(code.used_count).toBe(1);
    expect(ids.coach).toBe(bind.body.coach_id);
  });
});
