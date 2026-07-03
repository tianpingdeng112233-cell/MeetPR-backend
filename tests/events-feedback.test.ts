import { randomUUID } from 'node:crypto';

import pino from 'pino';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app';
import { auth, config, ids, makeContext } from './helpers/studentActions';

const anonId = 'aa000000-0000-4000-8000-000000000001';
const sessionId = 'bb000000-0000-4000-8000-000000000001';

function feedback(overrides: Record<string, unknown> = {}) {
  return {
    event_id: randomUUID(),
    anon_id: anonId,
    session_id: sessionId,
    flow: 'record_set',
    from_screen: 'today_workout',
    trigger: 're_edit',
    text: '录组太麻烦了，想一次记多组',
    app_version: '0.1.0',
    build: '42',
    ts_client: '2026-06-24T19:03:11.000Z',
    ...overrides,
  };
}

async function feedbackCount(db: Awaited<ReturnType<typeof makeContext>>['db']): Promise<number> {
  return (await db.selectFrom('analytics_feedback').select('event_id').execute()).length;
}

describe('POST /events/feedback', () => {
  it('derives user_id from the JWT and ignores a forged client value', async () => {
    const ctx = await makeContext();

    const res = await request(ctx.app)
      .post('/events/feedback')
      .set(auth(ctx.traineeToken))
      .send(feedback({ user_id: ids.coach, role: 'coach' }));

    expect(res.status).toBe(204);
    const row = await ctx.db
      .selectFrom('analytics_feedback')
      .select(['user_id', 'text'])
      .executeTakeFirstOrThrow();
    expect(row.user_id).toBe(ids.trainee);
    expect(row.text).toBe('录组太麻烦了，想一次记多组');
  });

  it('stores anon-only feedback (no token) with NULL user_id', async () => {
    const ctx = await makeContext();

    const res = await request(ctx.app).post('/events/feedback').send(feedback());

    expect(res.status).toBe(204);
    const row = await ctx.db
      .selectFrom('analytics_feedback')
      .select('user_id')
      .executeTakeFirstOrThrow();
    expect(row.user_id).toBeNull();
  });

  describe('text validation (the free-text hard gate — reject, never truncate)', () => {
    const bad: [string, unknown][] = [
      ['empty string', ''],
      ['all whitespace', '   \t  '],
      ['over 500 chars', 'x'.repeat(501)],
      ['contains a control char', `hi${String.fromCharCode(7)}there`],
    ];

    it.each(bad)('rejects %s with 400', async (_label, text) => {
      const ctx = await makeContext();

      const res = await request(ctx.app).post('/events/feedback').send(feedback({ text }));

      expect(res.status).toBe(400);
      expect(await feedbackCount(ctx.db)).toBe(0);
    });

    it('accepts exactly 500 chars', async () => {
      const ctx = await makeContext();

      const res = await request(ctx.app)
        .post('/events/feedback')
        .send(feedback({ text: 'a'.repeat(500) }));

      expect(res.status).toBe(204);
      expect(await feedbackCount(ctx.db)).toBe(1);
    });
  });

  it('dedups a replayed event_id to exactly one row', async () => {
    const ctx = await makeContext();
    const body = feedback();

    await request(ctx.app).post('/events/feedback').send(body);
    await request(ctx.app).post('/events/feedback').send(body);

    expect(await feedbackCount(ctx.db)).toBe(1);
  });

  it('returns 5xx (not 204) when the insert fails', async () => {
    const ctx = await makeContext();
    vi.spyOn(ctx.db, 'insertInto').mockImplementation(() => {
      throw new Error('db down');
    });

    const res = await request(ctx.app).post('/events/feedback').send(feedback());

    expect(res.status).toBeGreaterThanOrEqual(500);
    vi.restoreAllMocks();
  });

  it('fails open on the dedicated limiter: 204, never 429', async () => {
    const ctx = await makeContext();
    const app = createApp({
      config: { ...config, EVENTS_RATE_LIMIT_MAX: 1 },
      logger: pino({ level: 'silent' }),
      db: ctx.db,
    });

    const first = await request(app).post('/events/feedback').send(feedback());
    const second = await request(app).post('/events/feedback').send(feedback());

    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    expect(await feedbackCount(ctx.db)).toBe(1);
  });

  it('writes ONLY analytics_feedback, never the events table (true gate: no free text in events)', async () => {
    const ctx = await makeContext();

    await request(ctx.app).post('/events/feedback').send(feedback());

    expect(await feedbackCount(ctx.db)).toBe(1);
    const events = await ctx.db.selectFrom('events').select('event_id').execute();
    expect(events).toHaveLength(0);
  });
});
