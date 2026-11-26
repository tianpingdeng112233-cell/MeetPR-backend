import { afterEach, expect, it, vi } from 'vitest';
import { request } from '../helpers/inMemoryRequest';
import { auth, createPublishedPlan, ids, makeContext } from '../helpers/studentActions';

afterEach(() => vi.useRealTimers());

it('records the actual date on an earlier session and keeps its confirmation clock on retry and undo', async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-12-01T12:00:00Z') });
  const ctx = await makeContext();
  const plan = await createPublishedPlan(ctx);
  const submit = (actual_completion_date: string) =>
    request(ctx.app)
      .post(`/plans/days/${plan.dayId}/complete`)
      .set(auth(ctx.traineeToken))
      .send({ actual_completion_date });

  const first = await submit('2026-11-24');
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({
    completed_at: '2026-12-01T12:00:00.000Z',
    actual_completion_date: '2026-11-24',
  });
  const detail = await request(ctx.app).get(`/plans/${plan.planId}`).set(auth(ctx.traineeToken));
  expect(detail.body.actual_completion_date_enabled).toBe(true);
  expect(detail.body.days[0].actual_completion_date).toBe('2026-11-24');
  const retry = await submit('2026-11-25');
  expect(retry.body).toEqual(first.body);
  expect((await submit('2026-12-02')).status).toBe(400);
  const undo = await request(ctx.app)
    .delete(`/plans/days/${plan.dayId}/complete`)
    .set(auth(ctx.traineeToken));
  expect(undo.status).toBe(204);
  const legacy = await request(ctx.app)
    .post(`/plans/days/${plan.dayId}/complete`)
    .set(auth(ctx.traineeToken));
  expect(legacy.status).toBe(200);
  expect(legacy.body.actual_completion_date).toBeNull();
});

it('validates real calendar dates and the 04:00 athlete-local upper bound', async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-25T19:59:59Z') });
  const ctx = await makeContext();
  const plan = await createPublishedPlan(ctx);
  await ctx.db
    .updateTable('users')
    .set({ timezone: 'Asia/Shanghai' })
    .where('id', '=', ids.trainee)
    .execute();
  const submit = (date: string) =>
    request(ctx.app)
      .post(`/plans/days/${plan.dayId}/complete`)
      .set(auth(ctx.traineeToken))
      .send({ actual_completion_date: date });
  expect((await submit('2026-11-31')).body.error).toBe('VALIDATION_ERROR');
  const future = await submit('2026-11-26');
  expect(future.status).toBe(400);
  expect(future.body.error).toBe('FUTURE_COMPLETION_DATE');
  vi.setSystemTime(new Date('2026-11-25T20:00:00Z'));
  expect((await submit('2026-11-26')).status).toBe(200);
});
