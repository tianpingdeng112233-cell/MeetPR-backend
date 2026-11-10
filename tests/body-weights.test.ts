import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auth, ids, makeContext, type TestContext } from './helpers/bindEval';

const base = '/students/me/body-weights';
const today = '2026-10-09';
const yesterday = '2026-10-08';
const tomorrow = '2026-10-10';

function put(ctx: TestContext, date: string, weight: unknown, token = ctx.boundStudentToken) {
  return request(ctx.app).put(`${base}/${date}`).set(auth(token)).send({ weight_kg: weight });
}
function remove(ctx: TestContext, date: string, token = ctx.boundStudentToken) {
  return request(ctx.app).delete(`${base}/${date}`).set(auth(token));
}
function get(ctx: TestContext, token = ctx.boundStudentToken) {
  return request(ctx.app).get(base).set(auth(token));
}
async function expectProfileWeight(ctx: TestContext, weight: string | null) {
  const response = await request(ctx.app)
    .get(`/students/${ids.boundStudent}/onboarding`)
    .set(auth(ctx.boundStudentToken));
  expect(response.status).toBe(200);
  expect(response.body.weight_kg).toBe(weight);
}

describe('student body weight records', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-09T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('GET returns an empty records array', async () => {
    const ctx = await makeContext();
    const response = await get(ctx);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ records: [] });
  });

  it.each(['get', 'put', 'delete'] as const)(
    '%s rejects coaches and unauthenticated requests',
    async (method) => {
      const ctx = await makeContext();
      const url = method === 'get' ? base : `${base}/${today}`;
      const coach = await request(ctx.app)
        [method](url)
        .set(auth(ctx.coachToken))
        .send({ weight_kg: 83 });
      expect(coach.status).toBe(403);
      expect(coach.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });
      const anonymous = await request(ctx.app)[method](url).send({ weight_kg: 83 });
      expect(anonymous.status).toBe(401);
      expect(anonymous.body).toEqual({ error: 'AUTH_INVALID_TOKEN' });
    },
  );

  it('PUT creates a profile when missing and normalizes numbers to two decimals', async () => {
    const ctx = await makeContext();
    const before = await request(ctx.app)
      .get(`/students/${ids.boundStudent}/onboarding`)
      .set(auth(ctx.boundStudentToken));
    expect(before.status).toBe(404);
    const response = await put(ctx, today, 83);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      record: { recorded_on: today, weight_kg: '83.00' },
      current_weight_kg: '83.00',
    });
    await expectProfileWeight(ctx, '83.00');
  });

  it('PUT overwrites the same day without adding a record', async () => {
    const ctx = await makeContext();
    expect((await put(ctx, today, '83.25')).status).toBe(200);
    const response = await put(ctx, today, '84.50');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      record: { recorded_on: today, weight_kg: '84.50' },
      current_weight_kg: '84.50',
    });
    expect((await get(ctx)).body).toEqual({
      records: [{ recorded_on: today, weight_kg: '84.50' }],
    });
    await expectProfileWeight(ctx, '84.50');
  });

  it('GET sorts all records ascending and isolates other students', async () => {
    const ctx = await makeContext();
    expect((await put(ctx, today, '83')).status).toBe(200);
    expect((await put(ctx, yesterday, '84')).status).toBe(200);
    expect((await put(ctx, tomorrow, '82', ctx.selfTrainStudentToken)).status).toBe(200);
    const response = await get(ctx);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      records: [
        { recorded_on: yesterday, weight_kg: '84.00' },
        { recorded_on: today, weight_kg: '83.00' },
      ],
    });
    expect((await get(ctx, ctx.selfTrainStudentToken)).body).toEqual({
      records: [{ recorded_on: tomorrow, weight_kg: '82.00' }],
    });
  });

  it.each(['83.251', 83.251, 0, -1, 500, '500', 'NaN', null, '', true])(
    'PUT rejects invalid weight %j using the validation envelope',
    async (weight) => {
      const ctx = await makeContext();
      const response = await put(ctx, today, weight);
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('VALIDATION_ERROR');
      expect((await get(ctx)).body).toEqual({ records: [] });
    },
  );

  it('PUT rejects a missing weight', async () => {
    const ctx = await makeContext();
    const response = await request(ctx.app)
      .put(`${base}/${today}`)
      .set(auth(ctx.boundStudentToken))
      .send({});
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('VALIDATION_ERROR');
  });

  it.each(['2026-10-07', '2026-10-11', '2026-02-30', '2026-13-01', '2026-1-09', 'not-a-date'])(
    'PUT rejects date %s',
    async (date) => {
      const ctx = await makeContext();
      const response = await put(ctx, date, 83);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'BODY_WEIGHT_DATE_OUT_OF_RANGE' });
    },
  );

  it('PUT uses calendar dates rather than a rolling 24-hour window', async () => {
    vi.setSystemTime(new Date('2026-10-09T23:59:59Z'));
    const ctx = await makeContext();
    expect((await put(ctx, yesterday, 84)).status).toBe(200);
    expect((await put(ctx, tomorrow, 82)).status).toBe(200);
  });

  it('PUT and DELETE keep the profile at the newest remaining date in any order', async () => {
    const ctx = await makeContext();
    expect((await put(ctx, today, '83')).status).toBe(200);
    const older = await put(ctx, yesterday, '84');
    expect(older.status).toBe(200);
    expect(older.body.current_weight_kg).toBe('83.00');
    await expectProfileWeight(ctx, '83.00');
    expect((await put(ctx, tomorrow, '82')).status).toBe(200);
    await expectProfileWeight(ctx, '82.00');
    const deletedOlder = await remove(ctx, yesterday);
    expect(deletedOlder.status).toBe(200);
    expect(deletedOlder.body).toEqual({ current_weight_kg: '82.00' });
    await expectProfileWeight(ctx, '82.00');
    const deletedLatest = await remove(ctx, tomorrow);
    expect(deletedLatest.status).toBe(200);
    expect(deletedLatest.body).toEqual({ current_weight_kg: '83.00' });
    await expectProfileWeight(ctx, '83.00');
    const deletedLast = await remove(ctx, today);
    expect(deletedLast.status).toBe(200);
    expect(deletedLast.body).toEqual({ current_weight_kg: null });
    await expectProfileWeight(ctx, null);
    expect((await get(ctx)).body).toEqual({ records: [] });
  });

  it('DELETE accepts old dates and self-training students', async () => {
    const ctx = await makeContext();
    expect((await put(ctx, today, 83, ctx.selfTrainStudentToken)).status).toBe(200);
    vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
    // Refresh JWT at the later date.
    const { signToken } = await import('./helpers/bindEval');
    const token = signToken(ids.selfTrainStudent, 'self_train_student');
    const response = await remove(ctx, today, token);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ current_weight_kg: null });
  });

  it('DELETE rejects invalid calendar dates with the validation envelope', async () => {
    const ctx = await makeContext();
    for (const date of ['2026-02-30', '2026-13-01', '2026-1-09', 'not-a-date']) {
      const response = await remove(ctx, date);
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('VALIDATION_ERROR');
    }
  });

  it('DELETE returns 404 for missing records and another user’s date', async () => {
    const ctx = await makeContext();
    expect((await put(ctx, today, 83, ctx.selfTrainStudentToken)).status).toBe(200);
    for (const date of [today, '2000-01-01']) {
      const response = await remove(ctx, date);
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'BODY_WEIGHT_NOT_FOUND' });
    }
    expect((await get(ctx, ctx.selfTrainStudentToken)).body).toEqual({
      records: [{ recorded_on: today, weight_kg: '83.00' }],
    });
  });
});
