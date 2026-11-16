import { afterEach, beforeEach, expect, it } from 'vitest';
import { request } from '../helpers/inMemoryRequest';
import {
  auth,
  createPublishedPlan,
  ids,
  makeContext,
  type TestContext,
} from '../helpers/studentActions';
import { utcDateOnly } from '../../src/utils/date';
let ctx: TestContext;
const base = new Date();
function date(n: number) {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + n);
  return utcDateOnly(d);
}
beforeEach(async () => {
  ctx = await makeContext(undefined, { config: { COACH_PLAN_SHIFT_ENABLED: true } });
});
afterEach(async () => {
  await ctx.db.destroy();
});
async function seed(
  start: number,
  end: number,
  status: 'draft' | 'published' | 'paused' = 'published',
) {
  const p = await createPublishedPlan(ctx);
  await ctx.db
    .updateTable('plans')
    .set({ start_date: date(start), end_date: date(end), status })
    .where('id', '=', p.planId)
    .execute();
  return p;
}
it('rejects publishing an overlapping draft and publishes a disjoint draft', async () => {
  const old = await seed(0, 27);
  const next = await seed(27, 54, 'draft');
  const conflict = await request(ctx.app)
    .post(`/plans/${next.planId}/publish`)
    .set(auth(ctx.coachToken));
  expect(conflict.status).toBe(409);
  expect(conflict.body).toMatchObject({
    error: 'PLAN_DATES_OVERLAP',
    conflicts: [
      { id: old.planId, name: 'Published Block', start_date: date(0), end_date: date(27) },
    ],
  });
  await request(ctx.app)
    .patch(`/plans/${next.planId}`)
    .set(auth(ctx.coachToken))
    .send({ start_date: date(28) });
  expect(
    (await request(ctx.app).post(`/plans/${next.planId}/publish`).set(auth(ctx.coachToken))).status,
  ).toBe(200);
});

it('rejects moving a published start into its predecessor and accepts a disjoint start', async () => {
  await seed(0, 27);
  const next = await seed(28, 55);
  const bad = await request(ctx.app)
    .patch(`/plans/${next.planId}`)
    .set(auth(ctx.coachToken))
    .send({ start_date: date(27) });
  expect(bad.status).toBe(409);
  expect(bad.body.error).toBe('PLAN_DATES_OVERLAP');
  const good = await request(ctx.app)
    .patch(`/plans/${next.planId}`)
    .set(auth(ctx.coachToken))
    .send({ start_date: date(29) });
  expect(good.status).toBe(200);
});

it('rejects extending actual training days through batch into the next plan, allowing a shorter extension', async () => {
  const old = await seed(0, 20);
  await seed(28, 55);
  const payload = (week: number) => ({
    plan_patch: { plan_weeks: 6 },
    upsert_days: [{ week_number: week, day_of_week: 1, sort_order: 0, exercises: [] }],
  });
  const bad = await request(ctx.app)
    .post(`/plans/${old.planId}/days/batch`)
    .set(auth(ctx.coachToken))
    .send(payload(5));
  expect(bad.status).toBe(409);
  expect(bad.body.error).toBe('PLAN_DATES_OVERLAP');
  expect(
    (
      await request(ctx.app)
        .post(`/plans/${old.planId}/days/batch`)
        .set(auth(ctx.coachToken))
        .send(payload(4))
    ).status,
  ).toBe(200);
});

it('rejects a coach shift across the next start with the minimum required follow-on shift', async () => {
  const old = await seed(0, 27);
  await seed(28, 55);
  const bad = await request(ctx.app)
    .post(`/plans/${old.planId}/shift`)
    .set(auth(ctx.coachToken))
    .send({ anchor_date: date(0), offset_days: 30 });
  expect(bad.status).toBe(409);
  expect(bad.body).toMatchObject({ error: 'PLAN_DATES_OVERLAP', required_shift_days: 3 });
  expect(
    (
      await request(ctx.app)
        .post(`/plans/${old.planId}/shift`)
        .set(auth(ctx.coachToken))
        .send({ anchor_date: date(0), offset_days: 1 })
    ).status,
  ).toBe(201);
});

it('does not bypass overlap protection through legacy individual day create or patch', async () => {
  const old = await seed(0, 20);
  await seed(28, 55);
  const created = await request(ctx.app)
    .post(`/plans/${old.planId}/days`)
    .set(auth(ctx.coachToken))
    .send({ week_number: 5, day_of_week: 1, sort_order: 1 });
  expect(created.status).toBe(409);
  expect(created.body.error).toBe('PLAN_DATES_OVERLAP');
  const patched = await request(ctx.app)
    .patch(`/plans/days/${old.dayId}`)
    .set(auth(ctx.coachToken))
    .send({ week_number: 5 });
  expect(patched.status).toBe(409);
  expect(patched.body.error).toBe('PLAN_DATES_OVERLAP');
  const unchanged = await request(ctx.app).get(`/plans/${old.planId}`).set(auth(ctx.coachToken));
  expect(unchanged.body.days).toHaveLength(1);
  expect(unchanged.body.days[0].week_number).toBe(1);
});

it('allows unrelated edits and overlap reduction in existing overlapping plans but rejects expansion', async () => {
  const a = await seed(0, 35);
  await seed(28, 55);
  expect(
    (
      await request(ctx.app)
        .patch(`/plans/${a.planId}`)
        .set(auth(ctx.coachToken))
        .send({ name: 'Still editable' })
    ).status,
  ).toBe(200);
  expect(
    (
      await request(ctx.app)
        .patch(`/plans/${a.planId}`)
        .set(auth(ctx.coachToken))
        .send({ end_date: date(34) })
    ).status,
  ).toBe(200);
  const bad = await request(ctx.app)
    .patch(`/plans/${a.planId}`)
    .set(auth(ctx.coachToken))
    .send({ end_date: date(36) });
  expect(bad.status).toBe(409);
  expect(
    (
      await request(ctx.app)
        .post(`/plans/${a.planId}/days/batch`)
        .set(auth(ctx.coachToken))
        .send({ plan_patch: { name: 'Batch edit' } })
    ).status,
  ).toBe(200);
  const after = await request(ctx.app).get(`/plans/${a.planId}`).set(auth(ctx.coachToken));
  expect(after.body.end_date.slice(0, 10)).toBe(date(34));
});

it('checks paused-to-published and uses shifted actual ends of the conflicting plan', async () => {
  const old = await seed(0, 20);
  const next = await seed(28, 55, 'paused');
  await ctx.db
    .insertInto('plan_day_shifts')
    .values({
      plan_day_id: old.dayId,
      student_id: ids.trainee,
      batch_id: '99999999-0000-4000-8000-000000000001',
      shifted_to_date: date(30),
    })
    .execute();
  const bad = await request(ctx.app)
    .patch(`/plans/${next.planId}`)
    .set(auth(ctx.coachToken))
    .send({ status: 'published' });
  expect(bad.status).toBe(409);
  expect(bad.body.conflicts[0].end_date).toBe(date(30));
  expect(
    (
      await request(ctx.app)
        .patch(`/plans/${next.planId}`)
        .set(auth(ctx.coachToken))
        .send({ start_date: date(31), status: 'published' })
    ).status,
  ).toBe(200);
});

it('ignores rest days and other coaches; metadata-only plan_weeks adds no actual date', async () => {
  const old = await seed(0, 20);
  const next = await seed(28, 55);
  await ctx.db
    .insertInto('plan_days')
    .values({ plan_id: old.planId, week_number: 10, day_of_week: 1, is_rest: true })
    .execute();
  expect(
    (
      await request(ctx.app)
        .patch(`/plans/${old.planId}`)
        .set(auth(ctx.coachToken))
        .send({ plan_weeks: 10 })
    ).status,
  ).toBe(200);
  await ctx.db
    .updateTable('plans')
    .set({ coach_id: ids.otherCoach })
    .where('id', '=', next.planId)
    .execute();
  expect(
    (
      await request(ctx.app)
        .patch(`/plans/${old.planId}`)
        .set(auth(ctx.coachToken))
        .send({ end_date: date(35) })
    ).status,
  ).toBe(200);
});

it('checks batch end-date edits and leaves the rejected plan and tree intact', async () => {
  const old = await seed(0, 20);
  await seed(28, 55);
  const bad = await request(ctx.app)
    .post(`/plans/${old.planId}/days/batch`)
    .set(auth(ctx.coachToken))
    .send({
      plan_patch: { end_date: date(40), name: 'Must not persist' },
      delete_day_ids: [old.dayId],
    });
  expect(bad.status).toBe(409);
  const after = await request(ctx.app).get(`/plans/${old.planId}`).set(auth(ctx.coachToken));
  expect(after.body.name).toBe('Published Block');
  expect(after.body.days[0].id).toBe(old.dayId);
});

it('guards the legacy student shift and permits it when the next range is clear', async () => {
  await ctx.db
    .updateTable('users')
    .set({ timezone: 'UTC' })
    .where('id', '=', ids.trainee)
    .execute();
  const old = await seed(0, 0);
  const next = await seed(1, 28);
  const bad = await request(ctx.app).post(`/plans/${old.planId}/shift`).set(auth(ctx.traineeToken));
  expect(bad.status).toBe(409);
  expect(bad.body.error).toBe('PLAN_DATES_OVERLAP');
  await ctx.db
    .updateTable('plans')
    .set({ start_date: date(2) })
    .where('id', '=', next.planId)
    .execute();
  expect(
    (await request(ctx.app).post(`/plans/${old.planId}/shift`).set(auth(ctx.traineeToken))).status,
  ).toBe(201);
});

it.each(['coach', 'student'] as const)(
  'guards %s undo after a start-date edit would move the restored day into the next plan',
  async (role) => {
    await ctx.db
      .updateTable('users')
      .set({ timezone: 'UTC' })
      .where('id', '=', ids.trainee)
      .execute();
    const old = await seed(-27, 0);
    await ctx.db
      .updateTable('plan_days')
      .set({ week_number: 4, day_of_week: 7 })
      .where('id', '=', old.dayId)
      .execute();
    await seed(8, 35);
    const token = role === 'coach' ? ctx.coachToken : ctx.traineeToken;
    const shifted = await request(ctx.app)
      .post(`/plans/${old.planId}/shift`)
      .set(auth(token))
      .send(role === 'coach' ? { anchor_date: date(0), offset_days: 1 } : {});
    expect(shifted.status).toBe(201);
    expect(
      (
        await request(ctx.app)
          .patch(`/plans/${old.planId}`)
          .set(auth(ctx.coachToken))
          .send({ start_date: date(-17), end_date: date(3) })
      ).status,
    ).toBe(200);
    const undone = await request(ctx.app).delete(`/plans/${old.planId}/shift`).set(auth(token));
    expect(undone.status).toBe(409);
    expect(undone.body.error).toBe('PLAN_DATES_OVERLAP');
    expect(
      await ctx.db
        .selectFrom('plan_day_shifts')
        .selectAll()
        .where('plan_day_id', '=', old.dayId)
        .execute(),
    ).toHaveLength(1);
  },
);
