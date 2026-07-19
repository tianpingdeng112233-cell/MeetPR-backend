import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { getCoachExerciseUsage } from '../src/handlers/exercise-usage';
import {
  auth,
  createPublishedPlan,
  ids,
  makeContext,
  type PublishedPlanFixture,
  type TestContext,
} from './helpers/studentActions';

const ACCESSORY_ID = '20000000-0000-4000-8000-000000000002';

async function seedUsage(ctx: TestContext): Promise<void> {
  await ctx.db
    .insertInto('exercises')
    .values({
      id: ACCESSORY_ID,
      name: 'Accessory',
      exercise_type: 'accessory',
      main_lift_family: null,
      muscle_groups: ['back'],
      equipment: ['cable'],
      movement_pattern: ['horizontal_pull'],
    })
    .execute();

  const fixtures: PublishedPlanFixture[] = [];
  for (let index = 0; index < 4; index += 1) {
    fixtures.push(await createPublishedPlan(ctx));
  }
  const statuses = ['draft', 'published', 'completed', 'paused'] as const;
  for (const [index, fixture] of fixtures.entries()) {
    const status = statuses[index];
    if (status === undefined) throw new Error('Missing plan status fixture');
    await ctx.db.updateTable('plans').set({ status }).where('id', '=', fixture.planId).execute();
  }

  const first = fixtures[0];
  if (!first) throw new Error('Missing usage fixture');
  await ctx.db
    .insertInto('plan_exercises')
    .values([
      {
        plan_day_id: first.dayId,
        exercise_id: ids.exercise,
        is_main_lift: true,
        sort_order: 1,
      },
      {
        plan_day_id: first.dayId,
        exercise_id: ACCESSORY_ID,
        is_main_lift: false,
        sort_order: 2,
      },
    ])
    .execute();

  await createPublishedPlan(ctx, ids.otherCoach);
}

describe('GET /exercises/usage-stats', () => {
  it('aggregates every plan status and repeated row for only the current coach', async () => {
    const ctx = await makeContext();
    await seedUsage(ctx);

    expect(await getCoachExerciseUsage(ctx.db, ids.coach)).toEqual({
      stats: [
        { exercise_id: ids.exercise, plan_count: 5 },
        { exercise_id: ACCESSORY_ID, plan_count: 1 },
      ],
    });
    await ctx.db.destroy();
  });

  it('returns the current coach usage in descending count order', async () => {
    const ctx = await makeContext();
    await seedUsage(ctx);

    const response = await request(ctx.app).get('/exercises/usage-stats').set(auth(ctx.coachToken));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      stats: [
        { exercise_id: ids.exercise, plan_count: 5 },
        { exercise_id: ACCESSORY_ID, plan_count: 1 },
      ],
    });
    await ctx.db.destroy();
  });

  it('returns only positive usage rows for a different coach', async () => {
    const ctx = await makeContext();
    await seedUsage(ctx);

    const response = await request(ctx.app)
      .get('/exercises/usage-stats')
      .set(auth(ctx.otherCoachToken));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      stats: [{ exercise_id: ids.exercise, plan_count: 1 }],
    });
    await ctx.db.destroy();
  });

  it('rejects anonymous and student callers with the standard auth envelopes', async () => {
    const ctx = await makeContext();

    const anonymous = await request(ctx.app).get('/exercises/usage-stats');
    const student = await request(ctx.app)
      .get('/exercises/usage-stats')
      .set(auth(ctx.traineeToken));

    expect(anonymous.status).toBe(401);
    expect(anonymous.body).toEqual({ error: 'AUTH_INVALID_TOKEN' });
    expect(student.status).toBe(403);
    expect(student.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });
    await ctx.db.destroy();
  });
});
