import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { utcDate, utcDateOnly } from '../../src/utils/date';
import { request } from '../helpers/inMemoryRequest';
import { auth, createPublishedPlan, ids, makeContext, signToken } from '../helpers/studentActions';
import type { TestContext } from '../helpers/studentActions';

// Freeze at midday in Shanghai, using the real day's date rather than a fixed incident date.
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
const now = new Date(`${today}T04:00:00Z`);

function dateOffset(days: number): string {
  const date = utcDate(today);
  date.setUTCDate(date.getUTCDate() + days);
  return utcDateOnly(date);
}

async function seedPlan(ctx: TestContext, startOffset: number, endOffset: number) {
  const fixture = await createPublishedPlan(ctx);
  await ctx.db
    .updateTable('plans')
    .set({
      start_date: dateOffset(startOffset),
      end_date: dateOffset(endOffset),
      published_at: new Date(now.getTime() - (startOffset < 0 ? 2 : 1) * 86_400_000),
    })
    .where('id', '=', fixture.planId)
    .execute();
  return fixture;
}

describe('student plan list visibility', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    ctx = await makeContext();
  });

  afterEach(async () => {
    await ctx.db.destroy();
    vi.useRealTimers();
  });

  it('hides a newer published future plan while the old plan covers today', async () => {
    const oldPlan = await seedPlan(ctx, -28, 5);
    await seedPlan(ctx, 7, 34);

    const response = await request(ctx.app)
      .get(`/students/${ids.trainee}/plans`)
      .set(auth(ctx.traineeToken));

    expect(response.status).toBe(200);
    expect(response.body.plans.map((plan: { id: string }) => plan.id)).toEqual([oldPlan.planId]);
  });

  it('still returns both plans to the coach', async () => {
    const oldPlan = await seedPlan(ctx, -28, 5);
    const futurePlan = await seedPlan(ctx, 7, 34);

    const response = await request(ctx.app)
      .get(`/students/${ids.trainee}/plans`)
      .set(auth(ctx.coachToken));

    expect(response.status).toBe(200);
    expect(response.body.plans.map((plan: { id: string }) => plan.id).sort()).toEqual(
      [oldPlan.planId, futurePlan.planId].sort(),
    );
  });

  it('returns both plans when the old plan ended before yesterday', async () => {
    const oldPlan = await seedPlan(ctx, -28, -2);
    const futurePlan = await seedPlan(ctx, 7, 34);

    const response = await request(ctx.app)
      .get(`/students/${ids.trainee}/plans`)
      .set(auth(ctx.traineeToken));

    expect(response.status).toBe(200);
    expect(response.body.plans.map((plan: { id: string }) => plan.id).sort()).toEqual(
      [oldPlan.planId, futurePlan.planId].sort(),
    );
  });

  it('returns the only future plan', async () => {
    const futurePlan = await seedPlan(ctx, 7, 34);

    const response = await request(ctx.app)
      .get(`/students/${ids.trainee}/plans`)
      .set(auth(ctx.traineeToken));

    expect(response.status).toBe(200);
    expect(response.body.plans.map((plan: { id: string }) => plan.id)).toEqual([futurePlan.planId]);
  });

  it('returns both plans when the new plan starts today', async () => {
    const oldPlan = await seedPlan(ctx, -28, 5);
    const newPlan = await seedPlan(ctx, 0, 27);

    const response = await request(ctx.app)
      .get(`/students/${ids.trainee}/plans`)
      .set(auth(ctx.traineeToken));

    expect(response.status).toBe(200);
    expect(response.body.plans.map((plan: { id: string }) => plan.id).sort()).toEqual(
      [oldPlan.planId, newPlan.planId].sort(),
    );
  });

  it('counts a training day shifted past end_date as ongoing coverage', async () => {
    const oldPlan = await seedPlan(ctx, -28, -2);
    await seedPlan(ctx, 7, 34);
    await ctx.db
      .insertInto('plan_day_shifts')
      .values({
        plan_day_id: oldPlan.dayId,
        student_id: ids.trainee,
        batch_id: randomUUID(),
        shifted_to_date: dateOffset(2),
      })
      .execute();

    const response = await request(ctx.app)
      .get(`/students/${ids.trainee}/plans`)
      .set(auth(ctx.traineeToken));

    expect(response.status).toBe(200);
    expect(response.body.plans.map((plan: { id: string }) => plan.id)).toEqual([oldPlan.planId]);
  });

  it('includes the end date even if the last training day was earlier', async () => {
    const oldPlan = await seedPlan(ctx, -28, 0);
    await seedPlan(ctx, 7, 34);

    const response = await request(ctx.app)
      .get(`/students/${ids.trainee}/plans`)
      .set(auth(ctx.traineeToken));

    expect(response.status).toBe(200);
    expect(response.body.plans.map((plan: { id: string }) => plan.id)).toEqual([oldPlan.planId]);
  });

  it.each([false, true])(
    'only training days in an extended week extend coverage (is_rest=%s)',
    async (isRest) => {
      const oldPlan = await seedPlan(ctx, -28, -2);
      const futurePlan = await seedPlan(ctx, 7, 34);
      const extension = await request(ctx.app)
        .patch(`/plans/${oldPlan.planId}`)
        .set(auth(ctx.coachToken))
        .send({ plan_weeks: 5 });
      expect(extension.status).toBe(200);
      // pg-mem serializes DATE columns as midnight timestamps in this fixture.
      expect(extension.body.end_date.slice(0, 10)).toBe(dateOffset(-2));
      await ctx.db
        .insertInto('plan_days')
        .values({
          plan_id: oldPlan.planId,
          week_number: 5,
          day_of_week: 3,
          is_rest: isRest,
          sort_order: 0,
        })
        .execute();

      const response = await request(ctx.app)
        .get(`/students/${ids.trainee}/plans`)
        .set(auth(ctx.traineeToken));

      expect(response.status).toBe(200);
      expect(response.body.plans.map((plan: { id: string }) => plan.id).sort()).toEqual(
        (isRest ? [oldPlan.planId, futurePlan.planId] : [oldPlan.planId]).sort(),
      );
    },
  );

  it.each([
    ['Asia/Shanghai', '15:59:59', false],
    ['Asia/Shanghai', '16:00:00', true],
    ['Pacific/Honolulu', '16:00:00', false],
  ])('uses the student calendar date in %s at %s UTC', async (timezone, time, newPlanVisible) => {
    vi.setSystemTime(new Date(`${today}T${time}Z`));
    await ctx.db.updateTable('users').set({ timezone }).where('id', '=', ids.trainee).execute();
    const oldPlan = await seedPlan(ctx, -28, 5);
    const newPlan = await seedPlan(ctx, 1, 28);

    const response = await request(ctx.app)
      .get(`/students/${ids.trainee}/plans`)
      .set(auth(signToken(ids.trainee, 'coached_student')));

    expect(response.status).toBe(200);
    expect(response.body.plans.map((plan: { id: string }) => plan.id).sort()).toEqual(
      (newPlanVisible ? [oldPlan.planId, newPlan.planId] : [oldPlan.planId]).sort(),
    );
  });

  it('preserves the response fields and direct access to a hidden future plan', async () => {
    const oldPlan = await seedPlan(ctx, -28, 5);
    const futurePlan = await seedPlan(ctx, 7, 34);
    const coachResponse = await request(ctx.app)
      .get(`/students/${ids.trainee}/plans`)
      .set(auth(ctx.coachToken));
    const studentResponse = await request(ctx.app)
      .get(`/students/${ids.trainee}/plans`)
      .set(auth(ctx.traineeToken));
    const detail = await request(ctx.app)
      .get(`/plans/${futurePlan.planId}`)
      .set(auth(ctx.traineeToken));

    expect(coachResponse.status).toBe(200);
    expect(studentResponse.status).toBe(200);
    expect(detail.status).toBe(200);
    expect(detail.body.id).toBe(futurePlan.planId);
    const coachPlan = coachResponse.body.plans.find(
      (plan: { id: string }) => plan.id === oldPlan.planId,
    );
    delete coachPlan.pending_revision_saved_at;
    expect(studentResponse.body).toEqual({ plans: [coachPlan] });
  });
});
