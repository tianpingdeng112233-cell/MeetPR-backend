import { afterEach, beforeEach, expect, it } from 'vitest';
import { utcDate, utcDateOnly } from '../../src/utils/date';
import { request } from '../helpers/inMemoryRequest';
import {
  auth,
  createPublishedPlan,
  ids,
  makeContext,
  type TestContext,
} from '../helpers/studentActions';

const today = utcDateOnly(new Date());
function dateOffset(days: number) {
  const date = utcDate(today);
  date.setUTCDate(date.getUTCDate() + days);
  return utcDateOnly(date);
}
let ctx: TestContext;
beforeEach(async () => {
  ctx = await makeContext();
});
afterEach(async () => {
  await ctx.db.destroy();
});
async function seed(start: number) {
  const fixture = await createPublishedPlan(ctx);
  await ctx.db
    .updateTable('plans')
    .set({
      start_date: dateOffset(start),
      end_date: dateOffset(start + 27),
      published_at: new Date(Date.now() + start * 86400000),
    })
    .where('id', '=', fixture.planId)
    .execute();
  return fixture;
}
async function list(token = ctx.traineeToken, suffix = '') {
  const response = await request(ctx.app)
    .get(`/students/${ids.trainee}/plans${suffix}`)
    .set(auth(token));
  expect(response.status).toBe(200);
  return response.body.plans as { id: string }[];
}
it('keeps the unfinished old cycle after the new start date and reveals the new cycle after settlement', async () => {
  const old = await seed(-40);
  const next = await seed(-5);
  expect((await list()).map((p) => p.id)).toEqual([old.planId]);
  const completed = await request(ctx.app)
    .post(`/plans/days/${old.dayId}/complete`)
    .set(auth(ctx.traineeToken));
  expect(completed.status).toBe(200);
  expect((await list()).map((p) => p.id).sort()).toEqual([old.planId, next.planId].sort());
});

async function log(plan: Awaited<ReturnType<typeof seed>>, at: Date, added = false) {
  await ctx.db
    .insertInto('set_logs')
    .values({
      student_id: ids.trainee,
      exercise_id: ids.exercise,
      plan_exercise_id: added ? null : plan.planExerciseId,
      plan_day_id: added ? plan.dayId : null,
      adhoc: added,
      set_index: 0,
      weight_kg: '100',
      reps: 1,
      completed: false,
      failed: false,
      logged_date: today,
      logged_at: at,
    })
    .execute();
}

it('hides only the untouched upcoming cycle in the feedback scenario and supports include_all', async () => {
  const old = await seed(-28);
  const next = await seed(7);
  await log(old, new Date());
  const visible = await list();
  expect(visible.map((p) => p.id)).toEqual([old.planId]);
  const all = await list(ctx.traineeToken, '?include_all=true');
  expect(all.map((p) => p.id).sort()).toEqual([old.planId, next.planId].sort());
  expect(visible[0]).toEqual(all.find((p) => p.id === old.planId));
  expect((await list(ctx.coachToken)).map((p) => p.id).sort()).toEqual(
    [old.planId, next.planId].sort(),
  );
  expect(
    (await request(ctx.app).get(`/plans/${next.planId}`).set(auth(ctx.traineeToken))).status,
  ).toBe(200);
});

it('preserves an earlier recorded plan republished after the current plan (A/B history regression)', async () => {
  const a = await seed(-60);
  const b = await seed(-20);
  await log(a, new Date(Date.now() - 86400000));
  await log(b, new Date());
  await ctx.db
    .updateTable('plans')
    .set({ published_at: new Date(Date.now() + 1000) })
    .where('id', '=', a.planId)
    .execute();
  expect((await list()).map((p) => p.id).sort()).toEqual([a.planId, b.planId].sort());
});

it.each(['planned', 'added', 'completion'])(
  'never hides an upcoming plan with a %s record even if another plan is the latest anchor',
  async (type) => {
    const old = await seed(-30);
    const next = await seed(5);
    const earlier = new Date(Date.now() - 86400000);
    if (type === 'completion')
      await ctx.db
        .insertInto('plan_day_completions')
        .values({
          plan_day_id: next.dayId,
          student_id: ids.trainee,
          source: 'manual',
          completed_at: earlier,
        })
        .execute();
    else await log(next, earlier, type === 'added');
    await log(old, new Date());
    expect((await list()).map((p) => p.id).sort()).toEqual([old.planId, next.planId].sort());
  },
);

it('returns no plans, a single future plan, and validates include_all', async () => {
  expect(await list()).toEqual([]);
  const only = await seed(7);
  expect((await list()).map((p) => p.id)).toEqual([only.planId]);
  const bad = await request(ctx.app)
    .get(`/students/${ids.trainee}/plans?include_all=maybe`)
    .set(auth(ctx.traineeToken));
  expect(bad.status).toBe(400);
});
