import { randomUUID } from 'node:crypto';

import pino from 'pino';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app';
import { auth, config, ids, makeContext } from './helpers/studentActions';

const anonId = 'aa000000-0000-4000-8000-000000000001';
const sessionId = 'bb000000-0000-4000-8000-000000000001';

function evt(overrides: Record<string, unknown> = {}) {
  return {
    event_id: randomUUID(),
    session_id: sessionId,
    seq: 0,
    name: 'app_open',
    props: { cold: true },
    schema_version: 1,
    ts_client: '2026-06-24T19:03:11.000Z',
    ...overrides,
  };
}

function batch(events: unknown[], top: Record<string, unknown> = {}) {
  return { anon_id: anonId, app_version: '0.1.0', build: '42', platform: 'ios', events, ...top };
}

async function countEvents(db: Awaited<ReturnType<typeof makeContext>>['db']): Promise<number> {
  const rows = await db.selectFrom('events').select('event_id').execute();
  return rows.length;
}

describe('POST /events', () => {
  it('partial-accepts: keeps valid events, skips invalid ones, returns 204', async () => {
    const ctx = await makeContext();

    const res = await request(ctx.app)
      .post('/events')
      .send(
        batch([
          evt(), // valid app_open
          evt({ name: 'app_open', props: { cold: true, note: 'free text' } }), // unknown key
          evt({ name: 'totally_made_up', props: {} }), // unknown name
          evt({ name: 'screen_view', props: { screen: 'not_a_real_screen' } }), // bad enum
        ]),
      );

    expect(res.status).toBe(204);
    expect(await countEvents(ctx.db)).toBe(1);
  });

  it('returns 204 with 0 rows when every event is invalid', async () => {
    const ctx = await makeContext();

    const res = await request(ctx.app)
      .post('/events')
      .send(batch([evt({ name: 'nope', props: {} }), evt({ name: 'still_nope', props: {} })]));

    expect(res.status).toBe(204);
    expect(await countEvents(ctx.db)).toBe(0);
  });

  it('derives user_id/role from the JWT and ignores forged client values', async () => {
    const ctx = await makeContext();

    const res = await request(ctx.app)
      .post('/events')
      .set(auth(ctx.traineeToken))
      .send(batch([evt({ user_id: ids.coach, role: 'coach' })]));

    expect(res.status).toBe(204);
    const row = await ctx.db
      .selectFrom('events')
      .select(['user_id', 'role', 'anon_id'])
      .executeTakeFirstOrThrow();
    expect(row.user_id).toBe(ids.trainee);
    expect(row.role).toBe('coached_student');
    expect(row.anon_id).toBe(anonId);
  });

  it('stores anon-only events (no token) with NULL user_id, preserving anon_id', async () => {
    const ctx = await makeContext();

    const res = await request(ctx.app)
      .post('/events')
      .send(batch([evt({ name: 'onboarding_step', props: { step_index: 0, step_name: 'goal' } })]));

    expect(res.status).toBe(204);
    const row = await ctx.db
      .selectFrom('events')
      .select(['user_id', 'role', 'anon_id'])
      .executeTakeFirstOrThrow();
    expect(row.user_id).toBeNull();
    expect(row.role).toBeNull();
    expect(row.anon_id).toBe(anonId);
  });

  it('inserts N valid events as N rows', async () => {
    const ctx = await makeContext();

    const events = Array.from({ length: 50 }, (_, i) => evt({ seq: i }));
    const res = await request(ctx.app).post('/events').send(batch(events));

    expect(res.status).toBe(204);
    expect(await countEvents(ctx.db)).toBe(50);
  });

  it('dedups a replayed event_id to exactly one row (ON CONFLICT DO NOTHING)', async () => {
    const ctx = await makeContext();
    const dup = evt();

    const first = await request(ctx.app)
      .post('/events')
      .send(batch([dup]));
    const second = await request(ctx.app)
      .post('/events')
      .send(batch([dup]));

    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    expect(await countEvents(ctx.db)).toBe(1);
  });

  it('rejects a batch larger than 50 with 400 EVENTS_BATCH_TOO_LARGE', async () => {
    const ctx = await makeContext();

    const events = Array.from({ length: 51 }, (_, i) => evt({ seq: i }));
    const res = await request(ctx.app).post('/events').send(batch(events));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('EVENTS_BATCH_TOO_LARGE');
    expect(await countEvents(ctx.db)).toBe(0);
  });

  it('rejects an empty events array with 400', async () => {
    const ctx = await makeContext();

    const res = await request(ctx.app).post('/events').send(batch([]));

    expect(res.status).toBe(400);
  });

  it('returns 413 (not 500) for a body over the 1mb limit', async () => {
    const ctx = await makeContext();

    const res = await request(ctx.app)
      .post('/events')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ anon_id: anonId, events: [], pad: 'x'.repeat(1_200_000) }));

    expect(res.status).toBe(413);
  });

  it('returns 5xx (not 204) when the insert fails — proves await-insert-then-respond', async () => {
    const ctx = await makeContext();
    vi.spyOn(ctx.db, 'insertInto').mockImplementation(() => {
      throw new Error('db down');
    });

    const res = await request(ctx.app)
      .post('/events')
      .send(batch([evt()]));

    expect(res.status).toBeGreaterThanOrEqual(500);
    vi.restoreAllMocks();
  });

  it('fails open on the dedicated limiter: 204 + 0 new rows, never 429', async () => {
    const ctx = await makeContext();
    const app = createApp({
      config: { ...config, EVENTS_RATE_LIMIT_MAX: 1 },
      logger: pino({ level: 'silent' }),
      db: ctx.db,
    });

    const first = await request(app)
      .post('/events')
      .send(batch([evt()]));
    const second = await request(app)
      .post('/events')
      .send(batch([evt()]));

    expect(first.status).toBe(204);
    expect(second.status).toBe(204); // fail-open drop, NOT 429
    expect(await countEvents(ctx.db)).toBe(1);
  });
});

describe('GET /events/config', () => {
  it('returns { enabled, sample_rate } without a token', async () => {
    const ctx = await makeContext();

    const res = await request(ctx.app).get('/events/config');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true, sample_rate: 1 });
  });
});
