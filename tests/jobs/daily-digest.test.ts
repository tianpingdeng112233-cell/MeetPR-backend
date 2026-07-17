import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { deriveDailyDigestAggregateId, runDailyDigest } from '../../src/jobs/daily-digest';
import { ids, makeContext } from '../helpers/studentActions';

const gymDay = '2026-07-16';
const now = new Date('2026-07-17T00:00:00.000Z');
const logger = pino({ level: 'silent' });

type Context = Awaited<ReturnType<typeof makeContext>>;
type LedgerEventType = 'session_completed' | 'session_partial' | 'pr_e1rm';

async function addBond(ctx: Context, studentId: string, coachId: string): Promise<void> {
  await ctx.db
    .insertInto('bind_requests')
    .values({
      student_id: studentId,
      coach_id: coachId,
      status: 'accepted',
      expired_at: new Date('2026-07-31T00:00:00.000Z'),
    })
    .execute();
}

async function addEvent(
  ctx: Context,
  input: {
    eventType: LedgerEventType;
    studentId?: string;
    coachId?: string | null;
  },
): Promise<void> {
  const studentId = input.studentId ?? ids.trainee;
  await ctx.db
    .insertInto('student_events')
    .values({
      student_id: studentId,
      coach_id: input.coachId === undefined ? ids.coach : input.coachId,
      event_type: input.eventType,
      session_date: gymDay,
      occurred_at: now,
      payload: JSON.stringify({}),
      dedup_key:
        input.eventType === 'pr_e1rm'
          ? `pr:${studentId}:squat:${randomUUID()}`
          : `${input.eventType}:${studentId}:${gymDay}`,
    })
    .execute();
}

async function addMissedSignal(
  ctx: Context,
  studentId: string,
  coachId: string,
  missedDates: string[] = [gymDay],
): Promise<void> {
  await ctx.db
    .insertInto('student_signals')
    .values({
      student_id: studentId,
      coach_id: coachId,
      signal_type: 'missed_training',
      severity: 'red',
      status: 'open',
      reason: 'missed training',
      payload: JSON.stringify({ missed_dates: missedDates }),
      opened_at: now,
    })
    .execute();
}

function decodePayload(payload: unknown): Record<string, unknown> {
  return (typeof payload === 'string' ? JSON.parse(payload) : payload) as Record<string, unknown>;
}

async function outbox(ctx: Context) {
  return ctx.db
    .selectFrom('notification_outbox')
    .select(['aggregate_id', 'recipient_id', 'payload'])
    .orderBy('recipient_id', 'asc')
    .execute();
}

describe('runDailyDigest', () => {
  it('counts all four segments and excludes a partial followed by completed', async () => {
    const ctx = await makeContext();
    await addBond(ctx, ids.otherStudent, ids.coach);
    await addEvent(ctx, { eventType: 'session_partial' });
    await addEvent(ctx, { eventType: 'session_completed' });
    await addEvent(ctx, {
      eventType: 'session_partial',
      studentId: ids.otherStudent,
    });
    await addEvent(ctx, { eventType: 'pr_e1rm' });
    await addMissedSignal(ctx, ids.otherStudent, ids.coach);

    await runDailyDigest(ctx.db, gymDay, now, logger);

    const rows = await outbox(ctx);
    expect(rows).toHaveLength(1);
    const payload = decodePayload(rows[0]?.payload);
    expect(payload.counts).toEqual({
      session_completed: 1,
      session_partial: 1,
      missed_training: 1,
      pr_e1rm: 1,
    });
    expect(payload.aps).toEqual({
      alert: {
        title: '昨日训练摘要',
        body: '昨天：1 练完 · 1 部分完成 · 1 缺练 · 1 破 PR',
      },
    });
    expect(payload.gym_day).toBe(gymDay);
  });

  it('omits zero-valued segments from the copy', async () => {
    const ctx = await makeContext();
    await addEvent(ctx, { eventType: 'session_completed' });
    await addMissedSignal(ctx, ids.trainee, ids.coach);

    await runDailyDigest(ctx.db, gymDay, now, logger);

    const rows = await outbox(ctx);
    const payload = decodePayload(rows[0]?.payload);
    expect(payload.aps).toEqual({
      alert: { title: '昨日训练摘要', body: '昨天：1 练完 · 1 缺练' },
    });
  });

  it('does not enqueue a digest when every count is zero', async () => {
    const ctx = await makeContext();

    await runDailyDigest(ctx.db, gymDay, now, logger);

    expect(await outbox(ctx)).toEqual([]);
  });

  it('is idempotent on rerun and derives a stable UUIDv5-shaped aggregate id', async () => {
    const ctx = await makeContext();
    await addEvent(ctx, { eventType: 'session_completed' });

    await runDailyDigest(ctx.db, gymDay, now, logger);
    await runDailyDigest(ctx.db, gymDay, now, logger);

    const rows = await outbox(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.aggregate_id).toBe(deriveDailyDigestAggregateId(ids.coach, gymDay));
    expect(rows[0]?.aggregate_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(deriveDailyDigestAggregateId(ids.coach, gymDay)).not.toBe(
      deriveDailyDigestAggregateId(ids.coach, '2026-07-15'),
    );
    // Fixed vector: pins the RFC 4122 v5 derivation (namespace bytes + name).
    // If this changes, outbox idempotency across deploys is broken.
    expect(deriveDailyDigestAggregateId('10000000-0000-4000-8000-000000000001', '2026-07-16')).toBe(
      '251a29ed-568e-5d17-a383-f75b4641f8ee',
    );
  });

  it('dedups a partial against a completed event even when its coach attribution is null', async () => {
    const ctx = await makeContext();
    await addEvent(ctx, { eventType: 'session_partial', studentId: ids.trainee });
    await addEvent(ctx, { eventType: 'session_completed', studentId: ids.trainee, coachId: null });
    await addEvent(ctx, { eventType: 'pr_e1rm', studentId: ids.trainee });

    await runDailyDigest(ctx.db, gymDay, now, logger);

    const rows = await outbox(ctx);
    expect(rows).toHaveLength(1);
    expect(decodePayload(rows[0]?.payload).counts).toEqual({
      session_completed: 0,
      session_partial: 0,
      missed_training: 0,
      pr_e1rm: 1,
    });
  });

  it('keeps event ownership isolated between coaches', async () => {
    const ctx = await makeContext();
    await addBond(ctx, ids.otherStudent, ids.otherCoach);
    await addEvent(ctx, { eventType: 'session_completed', coachId: ids.coach });
    await addEvent(ctx, {
      eventType: 'session_partial',
      studentId: ids.otherStudent,
      coachId: ids.otherCoach,
    });

    await runDailyDigest(ctx.db, gymDay, now, logger);

    const rows = await outbox(ctx);
    expect(rows).toHaveLength(2);
    const byCoach = new Map(rows.map((row) => [row.recipient_id, decodePayload(row.payload)]));
    expect(byCoach.get(ids.coach)?.counts).toEqual({
      session_completed: 1,
      session_partial: 0,
      missed_training: 0,
      pr_e1rm: 0,
    });
    expect(byCoach.get(ids.otherCoach)?.counts).toEqual({
      session_completed: 0,
      session_partial: 1,
      missed_training: 0,
      pr_e1rm: 0,
    });
  });
});
