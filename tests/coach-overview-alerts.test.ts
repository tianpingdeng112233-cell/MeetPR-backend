import fs from 'node:fs';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from './helpers/inMemoryRequest';
import {
  auth,
  createPublishedPlan,
  ids,
  makeContext,
  type TestContext,
} from './helpers/studentActions';

const now = new Date('2026-10-22T12:00:00Z');
const contexts: TestContext[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
});
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(contexts.splice(0).map((ctx) => ctx.db.destroy()));
});
async function context(afterQuery?: (query: string) => Promise<void>) {
  const ctx = await makeContext(undefined, afterQuery ? { afterQuery } : {});
  contexts.push(ctx);
  // Install the production migration on the existing coach-route fixture.
  const path = 'db/migrations/0079-coach-student-plan-views.sql';
  await sql.raw(fs.readFileSync(path, 'utf8')).execute(ctx.db);
  return ctx;
}
async function seed(ctx: TestContext, coachId = ids.coach, studentId = ids.trainee) {
  const plan = await createPublishedPlan(ctx, coachId, studentId);
  await ctx.db
    .updateTable('plans')
    .set({ start_date: '2026-10-20', end_date: '2026-10-25' })
    .where('id', '=', plan.planId)
    .execute();
  await ctx.db
    .updateTable('plan_sets')
    .set({ load_mode: 'rpe', target_rpe: '8.0' })
    .where('plan_exercise_id', '=', plan.planExerciseId)
    .execute();
  await ctx.db
    .insertInto('plan_sets')
    .values({
      plan_exercise_id: plan.planExerciseId,
      set_number: 2,
      target_reps: 5,
      intensity_mode: 'weight',
      target_value: '100',
      set_type: 'working',
      rest_seconds: null,
    })
    .execute();
  await ctx.db
    .insertInto('plan_days')
    .values({ plan_id: plan.planId, day_of_week: 2, week_number: 1 })
    .execute();
  await ctx.db
    .insertInto('set_logs')
    .values({
      student_id: studentId,
      plan_exercise_id: plan.planExerciseId,
      exercise_id: ids.exercise,
      set_index: 0,
      weight_kg: '100',
      reps: 5,
      rpe: '9.0',
      completed: true,
      logged_date: '2026-10-20',
      logged_at: new Date('2026-10-20T12:00:00Z'),
    })
    .execute();
  await ctx.db
    .insertInto('plan_day_completions')
    .values({
      student_id: studentId,
      plan_day_id: plan.dayId,
      source: 'manual',
      completed_at: new Date('2026-10-20T13:00:00Z'),
    })
    .execute();
  return plan;
}
const get = (ctx: TestContext, token = ctx.coachToken) =>
  request(ctx.app).get('/coach/overview-alerts').set(auth(token));
const viewed = (ctx: TestContext, token = ctx.coachToken) =>
  request(ctx.app).post(`/coach/students/${ids.trainee}/plan-viewed`).set(auth(token));

describe('coach overview alert routes', () => {
  it('summarizes plan/log data and dismisses training after plan-viewed, preserving plan ending', async () => {
    const ctx = await context();
    const plan = await seed(ctx);
    const before = await get(ctx);
    expect(before.status).toBe(200);
    expect(before.body.plan_ending).toEqual([
      {
        student_id: ids.trainee,
        plan_id: plan.planId,
        plan_name: 'Published Block',
        end_date: '2026-10-25',
        days_left: 3,
      },
    ]);
    expect(before.body.training).toHaveLength(1);
    expect(before.body.training[0].items.map((item: { type: string }) => item.type)).toEqual([
      'behind',
      'rpe_over',
      'incomplete',
    ]);
    expect(before.body.training[0].items).toContainEqual(
      expect.objectContaining({
        type: 'rpe_over',
        actual_rpe: '9.0',
        target_rpe: '8.0',
        set_index: 0,
      }),
    );
    expect((await viewed(ctx)).status).toBe(204);
    const after = await get(ctx);
    expect(after.status).toBe(200);
    expect(after.body.training).toEqual([]);
    expect(after.body.plan_ending).toEqual(before.body.plan_ending);
  });
  it('updates seen_at and repeat calls remain idempotent', async () => {
    const ctx = await context();
    await seed(ctx);
    expect((await viewed(ctx)).status).toBe(204);
    vi.setSystemTime(new Date('2026-10-22T12:05:00Z'));
    expect((await viewed(ctx)).status).toBe(204);
    expect((await viewed(ctx)).status).toBe(204);
    expect(await ctx.db.selectFrom('coach_student_plan_views').selectAll().execute()).toEqual([
      { coach_id: ids.coach, student_id: ids.trainee, seen_at: new Date('2026-10-22T12:05:00Z') },
    ]);
  });
  it('rejects unauthenticated callers, student roles and a non-bound coach', async () => {
    const ctx = await context();
    await ctx.db.deleteFrom('bind_requests').where('coach_id', '=', ids.otherCoach).execute();
    expect((await request(ctx.app).get('/coach/overview-alerts')).status).toBe(401);
    expect((await get(ctx, ctx.traineeToken)).status).toBe(403);
    expect((await viewed(ctx, ctx.traineeToken)).status).toBe(403);
    const forbidden = await viewed(ctx, ctx.otherCoachToken);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toBe('AUTHORIZATION_FORBIDDEN');
    expect(
      (
        await request(ctx.app)
          .post('/coach/students/not-a-uuid/plan-viewed')
          .set(auth(ctx.coachToken))
      ).status,
    ).toBe(400);
  });
  it('does not return another coach plans or unbound students, including training alerts', async () => {
    const ctx = await context();
    await seed(ctx, ids.otherCoach);
    await seed(ctx, ids.coach, ids.otherStudent);
    expect((await get(ctx)).body).toEqual({
      generated_at: now.toISOString(),
      plan_ending: [],
      training: [],
    });
    await seed(ctx);
    await ctx.db.deleteFrom('bind_requests').where('coach_id', '=', ids.coach).execute();
    expect((await get(ctx)).body.training).toEqual([]);
    expect((await get(ctx)).body.plan_ending).toEqual([]);
    expect((await viewed(ctx)).status).toBe(403);
  });
  it('does not reinterpret old completed logs as missing when completion was recorded recently', async () => {
    const ctx = await context();
    const plan = await seed(ctx);
    await ctx.db
      .deleteFrom('plan_sets')
      .where('plan_exercise_id', '=', plan.planExerciseId)
      .where('set_number', '=', 2)
      .execute();
    await ctx.db
      .deleteFrom('plan_days')
      .where('plan_id', '=', plan.planId)
      .where('id', '!=', plan.dayId)
      .execute();
    await ctx.db
      .updateTable('set_logs')
      .set({ logged_date: '2026-10-01', logged_at: new Date('2026-10-01T12:00:00Z') })
      .execute();
    await ctx.db.updateTable('plan_day_completions').set({ completed_at: now }).execute();
    const response = await get(ctx);
    expect(response.status).toBe(200);
    expect(response.body.training).toEqual([]);
  });
  it('shows newly logged alerts after viewing and keeps seen records scoped to each coach', async () => {
    const ctx = await context();
    const plan = await seed(ctx);
    await seed(ctx, ids.otherCoach);
    expect((await viewed(ctx)).status).toBe(204);
    expect((await get(ctx)).body.training).toEqual([]);
    expect((await get(ctx, ctx.otherCoachToken)).body.training).toHaveLength(1);
    vi.setSystemTime(new Date('2026-10-22T12:01:00Z'));
    await ctx.db
      .updateTable('set_logs')
      .set({ logged_at: new Date(), logged_date: '2026-10-22' })
      .where('plan_exercise_id', '=', plan.planExerciseId)
      .execute();
    const response = await get(ctx);
    expect(response.body.training[0].items).toEqual([
      expect.objectContaining({ type: 'rpe_over', date: '2026-10-22' }),
    ]);
    expect(response.body.training[0].latest_at).toBe('2026-10-22T12:01:00.000Z');
  });
  it('loads student timezones and effective shifts from the database', async () => {
    const ctx = await context();
    const plan = await seed(ctx);
    await ctx.db
      .updateTable('users')
      .set({ timezone: 'America/Los_Angeles' })
      .where('id', '=', ids.trainee)
      .execute();
    vi.setSystemTime(new Date('2026-10-22T10:59:59Z')); // 03:59 local, training day Oct 21
    const early = await get(ctx);
    expect(early.body.plan_ending).toEqual([]);
    expect(early.body.training[0].items.map((item: { type: string }) => item.type)).not.toContain(
      'behind',
    );
    vi.setSystemTime(now);
    const day = await ctx.db
      .selectFrom('plan_days')
      .select('id')
      .where('plan_id', '=', plan.planId)
      .where('day_of_week', '=', 2)
      .executeTakeFirstOrThrow();
    await ctx.db
      .insertInto('plan_day_shifts')
      .values({
        plan_day_id: day.id,
        student_id: ids.trainee,
        batch_id: '90000000-0000-4000-8000-000000000001',
        shifted_to_date: '2026-10-23',
      })
      .execute();
    const shifted = await get(ctx);
    expect(shifted.body.plan_ending).toHaveLength(1);
    expect(shifted.body.training[0].items.map((item: { type: string }) => item.type)).not.toContain(
      'behind',
    );
  });
  it('does not load history for a plan that ended sixty days ago or change alerts', async () => {
    const queries: string[] = [];
    const ctx = await context((query) => {
      queries.push(query);
      return Promise.resolve();
    });
    queries.length = 0;
    const before = await get(ctx);
    expect(before.status).toBe(200);
    const count = queries.length;
    const oldPlan = await seed(ctx);
    await ctx.db
      .updateTable('plans')
      .set({ start_date: '2026-08-18', end_date: '2026-08-23' })
      .where('id', '=', oldPlan.planId)
      .execute();
    await ctx.db
      .updateTable('set_logs')
      .set({ logged_date: '2026-08-18', logged_at: new Date('2026-08-18T12:00:00Z') })
      .where('plan_exercise_id', '=', oldPlan.planExerciseId)
      .execute();
    await ctx.db
      .updateTable('plan_day_completions')
      .set({ completed_at: new Date('2026-08-18T13:00:00Z') })
      .where('plan_day_id', '=', oldPlan.dayId)
      .execute();
    queries.length = 0;
    const after = await get(ctx);
    expect(after.status).toBe(200);
    expect(after.body).toEqual(before.body);
    // An excluded plan must not trigger any of its downstream history reads.
    expect(queries).toHaveLength(count);
    expect(queries.some((query) => query.includes('from "plan_days"'))).toBe(false);
  });
  it('uses a constant query count when the bound roster grows to fifty students', async () => {
    const queries: string[] = [];
    const ctx = await context((query) => {
      queries.push(query);
      return Promise.resolve();
    });
    await seed(ctx);
    queries.length = 0;
    expect((await get(ctx)).status).toBe(200);
    const count = queries.length;
    const studentIds = Array.from(
      { length: 49 },
      (_, index) => `90000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    );
    await ctx.db
      .insertInto('users')
      .values(
        studentIds.map((id, index) => ({
          id,
          phone: `+86139000${String(index).padStart(5, '0')}`,
          password_hash: 'hash',
          role: 'coached_student' as const,
        })),
      )
      .execute();
    await ctx.db
      .insertInto('bind_requests')
      .values(
        studentIds.map((student_id) => ({
          coach_id: ids.coach,
          student_id,
          status: 'accepted' as const,
          expired_at: now,
        })),
      )
      .execute();
    const plans = await ctx.db
      .insertInto('plans')
      .values(
        studentIds.map((trainee_id) => ({
          coach_id: ids.coach,
          trainee_id,
          name: 'Roster block',
          start_date: '2026-10-21',
          end_date: '2026-10-25',
          plan_weeks: 1,
          source: 'coach' as const,
          status: 'published' as const,
        })),
      )
      .returning('id')
      .execute();
    await ctx.db
      .insertInto('plan_days')
      .values(plans.map((plan) => ({ plan_id: plan.id, week_number: 1, day_of_week: 1 })))
      .execute();
    queries.length = 0;
    const response = await get(ctx);
    expect(response.status).toBe(200);
    expect(response.body.plan_ending).toHaveLength(50);
    expect(response.body.training).toHaveLength(50);
    expect(queries).toHaveLength(count);
    expect(count).toBeLessThanOrEqual(10);
  });
});
