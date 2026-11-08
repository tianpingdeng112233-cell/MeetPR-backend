import { describe, expect, it } from 'vitest';

import type { Insertable } from 'kysely';
import type { PlansTable } from '../src/db/types';
import { auth, ids, makeContext, type TestContext } from './helpers/bindEval';
import { request } from './helpers/inMemoryRequest';

async function addPlan(ctx: TestContext, overrides: Partial<Insertable<PlansTable>> = {}) {
  return ctx.db
    .insertInto('plans')
    .values({
      coach_id: ids.coach,
      trainee_id: ids.boundStudent,
      name: 'First block',
      start_date: '2026-06-01',
      end_date: '2026-06-28',
      plan_weeks: 4,
      source: 'coach',
      status: 'published',
      published_at: new Date('2026-06-01T00:00:00Z'),
      ...overrides,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
}

describe('GET /bind-requests/mine first_run', () => {
  it.each(['draft', 'old', 'other coach', 'other student'] as const)(
    'excludes %s plans and their settled days',
    async (kind) => {
      const ctx = await makeContext();
      const plan = await addPlan(ctx, {
        ...(kind === 'draft' ? { status: 'draft' as const, published_at: null } : {}),
        ...(kind === 'old' ? { published_at: new Date('2026-05-31T23:59:59.999Z') } : {}),
        ...(kind === 'other coach' ? { coach_id: ids.otherCoach, published_at: null } : {}),
        ...(kind === 'other student' ? { trainee_id: ids.freeStudent, published_at: null } : {}),
      });
      const day = await ctx.db
        .insertInto('plan_days')
        .values({
          plan_id: plan.id,
          week_number: 1,
          day_of_week: 1,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await ctx.db
        .insertInto('plan_day_completions')
        .values({
          plan_day_id: day.id,
          student_id: kind === 'other student' ? ids.freeStudent : ids.boundStudent,
          source: 'manual',
        })
        .execute();
      const mine = await request(ctx.app)
        .get('/bind-requests/mine')
        .set(auth(ctx.boundStudentToken));
      expect(mine.status).toBe(200);
      expect(mine.body.bind_request.first_run).toEqual({
        binding_plan_count: 0,
        has_settled_day: false,
        first_plan: null,
      });
    },
  );

  it('orders first_plan by publication then id and separates its settlement from later plans', async () => {
    const ctx = await makeContext();
    const later = await addPlan(ctx, {
      id: '90000000-0000-4000-8000-000000000001',
      published_at: new Date('2026-06-02'),
    });
    await addPlan(ctx, { id: '90000000-0000-4000-8000-000000000003' });
    const first = await addPlan(ctx, {
      id: '90000000-0000-4000-8000-000000000002',
      plan_weeks: 2,
    });
    await ctx.db
      .insertInto('plan_days')
      .values([
        { plan_id: first.id, week_number: 1, day_of_week: 1 },
        { plan_id: first.id, week_number: 2, day_of_week: 1 },
      ])
      .execute();
    const day = await ctx.db
      .insertInto('plan_days')
      .values({
        plan_id: later.id,
        week_number: 1,
        day_of_week: 1,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await ctx.db
      .insertInto('plan_day_completions')
      .values({
        plan_day_id: day.id,
        student_id: ids.boundStudent,
        source: 'backfill',
      })
      .execute();
    const mine = await request(ctx.app).get('/bind-requests/mine').set(auth(ctx.boundStudentToken));
    expect(mine.status).toBe(200);
    expect(mine.body.bind_request.first_run).toEqual({
      binding_plan_count: 3,
      has_settled_day: true,
      first_plan: {
        id: first.id,
        published_at: '2026-06-01T00:00:00.000Z',
        plan_weeks: 2,
        day_count: 2,
        has_settled_day: false,
      },
    });
  });

  it('keeps an empty published plan with zero training days', async () => {
    const ctx = await makeContext();
    const plan = await addPlan(ctx);
    const mine = await request(ctx.app).get('/bind-requests/mine').set(auth(ctx.boundStudentToken));
    expect(mine.status).toBe(200);
    expect(mine.body.bind_request.first_run).toEqual({
      binding_plan_count: 1,
      has_settled_day: false,
      first_plan: {
        id: plan.id,
        published_at: '2026-06-01T00:00:00.000Z',
        plan_weeks: 4,
        day_count: 0,
        has_settled_day: false,
      },
    });
  });

  it('returns null if an accepted binding lacks responded_at', async () => {
    const ctx = await makeContext();
    await ctx.db
      .updateTable('bind_requests')
      .set({ responded_at: null })
      .where('id', '=', ids.acceptedBindRequest)
      .execute();
    const mine = await request(ctx.app).get('/bind-requests/mine').set(auth(ctx.boundStudentToken));
    expect(mine.status).toBe(200);
    expect(mine.body.bind_request.first_run).toBeNull();
  });

  it.each(['rejected', 'expired', 'cancelled'] as const)('returns null for %s', async (status) => {
    const ctx = await makeContext();
    await addPlan(ctx);
    await ctx.db
      .updateTable('bind_requests')
      .set({ status })
      .where('id', '=', ids.acceptedBindRequest)
      .execute();
    const mine = await request(ctx.app).get('/bind-requests/mine').set(auth(ctx.boundStudentToken));
    expect(mine.status).toBe(200);
    expect(mine.body.bind_request.first_run).toBeNull();
  });

  it('does not add first_run to creation, coach queue or acceptance responses', async () => {
    const ctx = await makeContext();
    const code = await request(ctx.app)
      .post('/coach/invite-codes')
      .set(auth(ctx.coachToken))
      .send({ type: 'personal_permanent' });
    expect(code.status).toBe(201);
    const created = await request(ctx.app)
      .post('/bind-requests')
      .set(auth(ctx.freeStudentToken))
      .send({ code: code.body.code, display_name: 'New Student' });
    expect(created.status).toBe(201);
    expect(created.body).not.toHaveProperty('first_run');
    const queue = await request(ctx.app).get('/coach/bind-requests').set(auth(ctx.coachToken));
    expect(queue.status).toBe(200);
    expect(queue.body.bind_requests).toHaveLength(1);
    expect(queue.body.bind_requests[0]).not.toHaveProperty('first_run');
    const accepted = await request(ctx.app)
      .post(`/coach/bind-requests/${String(created.body.id)}/accept`)
      .set(auth(ctx.coachToken))
      .send({ skip_evaluation: true });
    expect(accepted.status).toBe(200);
    expect(accepted.body.bind_request).not.toHaveProperty('first_run');
  });

  it.each(['published', 'paused', 'completed'] as const)(
    'returns null when a %s candidate lacks published_at',
    async (status) => {
      const ctx = await makeContext();
      await addPlan(ctx);
      await addPlan(ctx, { status, published_at: null });
      const mine = await request(ctx.app)
        .get('/bind-requests/mine')
        .set(auth(ctx.boundStudentToken));
      expect(mine.status).toBe(200);
      expect(mine.body.bind_request.first_run).toBeNull();
    },
  );

  it.each(
    (['published', 'paused', 'completed'] as const).flatMap((status) =>
      [false, true].map((settled) => ({ status, settled })),
    ),
  )(
    'preserves binding totals for a $status first plan with settled=$settled',
    async ({ status, settled }) => {
      const ctx = await makeContext();
      const plan = await addPlan(ctx, { status });
      await addPlan(ctx, { published_at: new Date('2026-06-02T00:00:00Z') });
      const day = await ctx.db
        .insertInto('plan_days')
        .values({
          plan_id: plan.id,
          week_number: 1,
          day_of_week: 1,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      if (settled) {
        await ctx.db
          .insertInto('plan_day_completions')
          .values({
            plan_day_id: day.id,
            student_id: ids.boundStudent,
            source: 'manual',
          })
          .execute();
      }
      const mine = await request(ctx.app)
        .get('/bind-requests/mine')
        .set(auth(ctx.boundStudentToken));
      expect(mine.status).toBe(200);
      expect(mine.body.bind_request.first_run).toEqual({
        binding_plan_count: 2,
        has_settled_day: settled,
        first_plan:
          status === 'published'
            ? {
                id: plan.id,
                published_at: '2026-06-01T00:00:00.000Z',
                plan_weeks: 4,
                day_count: 1,
                has_settled_day: settled,
              }
            : null,
      });
    },
  );

  it('returns zero plans for a newly accepted student', async () => {
    const ctx = await makeContext();
    const mine = await request(ctx.app).get('/bind-requests/mine').set(auth(ctx.boundStudentToken));
    expect(mine.status).toBe(200);
    expect(mine.body.bind_request.first_run).toEqual({
      binding_plan_count: 0,
      has_settled_day: false,
      first_plan: null,
    });
  });

  it('returns null for a pending request and no bind_request when none exists', async () => {
    const ctx = await makeContext();
    const empty = await request(ctx.app).get('/bind-requests/mine').set(auth(ctx.freeStudentToken));
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ bind_request: null });

    await ctx.db
      .updateTable('bind_requests')
      .set({
        status: 'pending',
        responded_at: null,
        expired_at: new Date('2099-01-01'),
      })
      .where('id', '=', ids.acceptedBindRequest)
      .execute();
    const mine = await request(ctx.app).get('/bind-requests/mine').set(auth(ctx.boundStudentToken));
    expect(mine.status).toBe(200);
    expect(mine.body.bind_request.first_run).toBeNull();
  });
});
