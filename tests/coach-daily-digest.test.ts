import { randomUUID } from 'node:crypto';
import pino from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { runDailyDigest } from '../src/jobs/daily-digest';
import { justClosedGymDay } from '../src/jobs/scheduler';
import { auth, ids, makeContext } from './helpers/studentActions';

const gymDay = '2026-07-16';
const now = new Date('2026-07-17T00:00:00.000Z');
const logger = pino({ level: 'silent' });

type Context = Awaited<ReturnType<typeof makeContext>>;

async function addEvent(
  ctx: Context,
  eventType: 'session_completed' | 'session_partial' | 'pr_e1rm' | 'set_failed',
  studentId = ids.trainee,
): Promise<void> {
  await ctx.db
    .insertInto('student_events')
    .values({
      student_id: studentId,
      coach_id: ids.coach,
      event_type: eventType,
      session_date: gymDay,
      occurred_at: now,
      payload: JSON.stringify({}),
      dedup_key:
        eventType === 'pr_e1rm'
          ? `pr:${studentId}:squat:${randomUUID()}`
          : eventType === 'set_failed'
            ? `fail:${studentId}:${randomUUID()}`
            : `${eventType}:${studentId}:${gymDay}`,
    })
    .execute();
}

async function addMissedSignal(ctx: Context): Promise<void> {
  await ctx.db
    .insertInto('student_signals')
    .values({
      student_id: ids.trainee,
      coach_id: ids.coach,
      signal_type: 'missed_training',
      severity: 'red',
      status: 'open',
      reason: 'missed training',
      payload: JSON.stringify({ missed_dates: [gymDay] }),
      opened_at: now,
    })
    .execute();
}

function decodePayload(payload: unknown) {
  return (typeof payload === 'string' ? JSON.parse(payload) : payload) as {
    aps: { alert: { body: string } };
    counts: Record<string, number>;
    gym_day: string;
  };
}

describe('GET /coach/daily-digest', () => {
  it('matches the job aggregation and copy on the same fixture without writing another outbox row', async () => {
    const ctx = await makeContext();
    await addEvent(ctx, 'session_partial');
    await addEvent(ctx, 'pr_e1rm');
    // set_failed proves the endpoint surfaces the job's real weight_failed
    // count instead of a hardcoded zero.
    await addEvent(ctx, 'set_failed');
    await addMissedSignal(ctx);

    await runDailyDigest(ctx.db, gymDay, now, logger);
    const jobRow = await ctx.db
      .selectFrom('notification_outbox')
      .select('payload')
      .executeTakeFirstOrThrow();
    const jobPayload = decodePayload(jobRow.payload);

    const response = await request(ctx.app)
      .get(`/coach/daily-digest?date=${gymDay}`)
      .set(auth(ctx.coachToken));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      gym_day: jobPayload.gym_day,
      counts: jobPayload.counts,
      body: jobPayload.aps.alert.body,
    });
    const outboxCount = await ctx.db.selectFrom('notification_outbox').select('id').execute();
    expect(outboxCount).toHaveLength(1);
  });

  it('returns a null body for all-zero counts', async () => {
    const ctx = await makeContext();

    const response = await request(ctx.app)
      .get(`/coach/daily-digest?date=${gymDay}`)
      .set(auth(ctx.coachToken));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      gym_day: gymDay,
      counts: {
        session_completed: 0,
        session_partial: 0,
        missed_training: 0,
        pr_e1rm: 0,
        weight_failed: 0,
      },
      body: null,
    });
    expect(await ctx.db.selectFrom('notification_outbox').select('id').execute()).toEqual([]);
  });

  it.each(['2026-02-30', '2026-7-16', 'not-a-date'])('rejects invalid date %s', async (date) => {
    const ctx = await makeContext();

    const response = await request(ctx.app)
      .get(`/coach/daily-digest?date=${date}`)
      .set(auth(ctx.coachToken));

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('VALIDATION_ERROR');
  });

  it('defaults to the just-closed gym day and rejects a student role', async () => {
    const ctx = await makeContext();
    const expectedGymDay = justClosedGymDay(new Date());

    const response = await request(ctx.app).get('/coach/daily-digest').set(auth(ctx.coachToken));
    const forbidden = await request(ctx.app)
      .get(`/coach/daily-digest?date=${gymDay}`)
      .set(auth(ctx.traineeToken));

    expect(response.status).toBe(200);
    expect(response.body.gym_day).toBe(expectedGymDay);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });
  });
});
