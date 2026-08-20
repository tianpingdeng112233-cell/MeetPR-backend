import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { describe, expect, it } from 'vitest';

import {
  dailyDigestBody,
  deriveDailyDigestAggregateId,
  runDailyDigest,
  type DailyDigestCounts,
} from '../../src/jobs/daily-digest';
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
    sessionDate?: string;
  },
): Promise<void> {
  const studentId = input.studentId ?? ids.trainee;
  const sessionDate = input.sessionDate ?? gymDay;
  await ctx.db
    .insertInto('student_events')
    .values({
      student_id: studentId,
      coach_id: input.coachId === undefined ? ids.coach : input.coachId,
      event_type: input.eventType,
      session_date: sessionDate,
      occurred_at: now,
      payload: JSON.stringify({}),
      dedup_key:
        input.eventType === 'pr_e1rm'
          ? `pr:${studentId}:squat:${randomUUID()}`
          : `${input.eventType}:${studentId}:${sessionDate}`,
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

function encodePayload(payload: unknown): string {
  return typeof payload === 'string' ? payload : JSON.stringify(payload);
}

async function outbox(ctx: Context) {
  return ctx.db
    .selectFrom('notification_outbox')
    .select(['aggregate_id', 'recipient_id', 'payload'])
    .orderBy('recipient_id', 'asc')
    .execute();
}

describe('runDailyDigest', () => {
  it('writes only coaches in the requested timezone bucket', async () => {
    const ctx = await makeContext();
    await ctx.db
      .updateTable('users')
      .set({ timezone: 'Europe/London' })
      .where('id', '=', ids.coach)
      .execute();
    await ctx.db
      .updateTable('users')
      .set({ timezone: 'America/New_York' })
      .where('id', '=', ids.otherCoach)
      .execute();
    await addBond(ctx, ids.otherStudent, ids.otherCoach);
    await addEvent(ctx, { eventType: 'session_completed', coachId: ids.coach });
    await addEvent(ctx, {
      eventType: 'session_completed',
      studentId: ids.otherStudent,
      coachId: ids.otherCoach,
    });

    await runDailyDigest(
      ctx.db,
      gymDay,
      new Date('2026-07-17T07:00:00.000Z'),
      logger,
      'Europe/London',
    );

    expect((await outbox(ctx)).map((row) => row.recipient_id)).toEqual([ids.coach]);
  });

  it('uses each London student latest closed gym-day for a Shanghai coach digest', async () => {
    const ctx = await makeContext();
    await ctx.db
      .updateTable('users')
      .set({ timezone: 'Europe/London' })
      .where('id', '=', ids.trainee)
      .execute();
    await addEvent(ctx, {
      eventType: 'session_completed',
      sessionDate: '2026-07-15',
    });
    await addEvent(ctx, { eventType: 'pr_e1rm', sessionDate: '2026-07-16' });
    await addMissedSignal(ctx, ids.trainee, ids.coach, ['2026-07-15']);

    // 08:00 Shanghai on July 17 is only 01:00 BST. The coach digest key is
    // July 16, while the London student's latest fully closed gym-day is July 15.
    await runDailyDigest(ctx.db, '2026-07-16', now, logger, 'Asia/Shanghai');

    const rows = await outbox(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.aggregate_id).toBe(deriveDailyDigestAggregateId(ids.coach, '2026-07-16'));
    expect(decodePayload(rows[0]?.payload).counts).toEqual({
      session_completed: 1,
      session_partial: 0,
      missed_training: 1,
      pr_e1rm: 0,
    });
  });

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

  it('enqueues English title and body for a global coach and keeps the aggregate id stable', async () => {
    const ctx = await makeContext();
    await ctx.db.updateTable('users').set({ phone: null }).where('id', '=', ids.coach).execute();
    await addEvent(ctx, { eventType: 'session_completed' });
    await addEvent(ctx, { eventType: 'pr_e1rm' });

    await runDailyDigest(ctx.db, gymDay, now, logger);

    const rows = await outbox(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.aggregate_id).toBe(deriveDailyDigestAggregateId(ids.coach, gymDay));
    const payload = decodePayload(rows[0]?.payload);
    expect(payload.aps).toEqual({
      alert: {
        title: "Yesterday's training recap",
        body: 'Yesterday: 1 done · 1 PR',
      },
    });
  });

  it('keeps the same-timezone first-run payload byte-identical while advancing its watermark', async () => {
    const ctx = await makeContext();
    await addEvent(ctx, { eventType: 'session_completed' });
    await addMissedSignal(ctx, ids.trainee, ids.coach);

    await runDailyDigest(ctx.db, gymDay, now, logger);

    const [row] = await outbox(ctx);
    expect(encodePayload(row?.payload)).toBe(
      JSON.stringify({
        aps: {
          alert: { title: '昨日训练摘要', body: '昨天：1 练完 · 1 缺练' },
        },
        counts: {
          session_completed: 1,
          session_partial: 0,
          missed_training: 1,
          pr_e1rm: 0,
        },
        gym_day: gymDay,
      }),
    );
    expect(
      await ctx.db
        .selectFrom('digest_watermarks')
        .select(['coach_id', 'student_id', 'last_gym_day'])
        .executeTakeFirstOrThrow(),
    ).toEqual({
      coach_id: ids.coach,
      student_id: ids.trainee,
      last_gym_day: new Date(`${gymDay}T00:00:00.000Z`),
    });
  });

  it('does not repeat or omit New York student days across unsynchronised US and UK DST changes', async () => {
    const ctx = await makeContext();
    await ctx.db
      .updateTable('users')
      .set({ timezone: 'Europe/London' })
      .where('id', '=', ids.coach)
      .execute();
    await ctx.db
      .updateTable('users')
      .set({ timezone: 'America/New_York' })
      .where('id', '=', ids.trainee)
      .execute();

    const eventDays: string[] = [];
    for (
      const cursor = new Date('2026-03-05T00:00:00Z');
      cursor <= new Date('2026-03-30T00:00:00Z');
    ) {
      eventDays.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    await ctx.db
      .insertInto('student_events')
      .values(
        eventDays.map((sessionDate) => ({
          student_id: ids.trainee,
          coach_id: ids.coach,
          event_type: 'session_completed' as const,
          session_date: sessionDate,
          occurred_at: new Date(`${sessionDate}T12:00:00Z`),
          payload: JSON.stringify({}),
          dedup_key: `session_completed:${ids.trainee}:${sessionDate}`,
        })),
      )
      .execute();

    for (
      const londonDate = new Date('2026-03-07T00:00:00Z');
      londonDate <= new Date('2026-04-01T00:00:00Z');
    ) {
      const date = londonDate.toISOString().slice(0, 10);
      const afterUkSwitch = date >= '2026-03-29';
      const nowAtLondon0805 = new Date(`${date}T${afterUkSwitch ? '07' : '08'}:05:00Z`);
      const coachGymDay = new Date(londonDate);
      coachGymDay.setUTCDate(coachGymDay.getUTCDate() - 1);
      await runDailyDigest(
        ctx.db,
        coachGymDay.toISOString().slice(0, 10),
        nowAtLondon0805,
        logger,
        'Europe/London',
      );
      await runDailyDigest(
        ctx.db,
        coachGymDay.toISOString().slice(0, 10),
        new Date(nowAtLondon0805.getTime() + 60 * 60 * 1000),
        logger,
        'Europe/London',
      );
      londonDate.setUTCDate(londonDate.getUTCDate() + 1);
    }

    const rows = await outbox(ctx);
    const reportedDays = rows.reduce(
      (total, row) =>
        total + (decodePayload(row.payload).counts as DailyDigestCounts).session_completed,
      0,
    );
    expect(reportedDays).toBe(eventDays.length);
    expect(rows).toHaveLength(eventDays.length - 1);
    expect(
      await ctx.db
        .selectFrom('digest_watermarks')
        .select('last_gym_day')
        .where('coach_id', '=', ids.coach)
        .where('student_id', '=', ids.trainee)
        .executeTakeFirstOrThrow(),
    ).toEqual({ last_gym_day: new Date('2026-03-31T00:00:00.000Z') });
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

describe('dailyDigestBody locales', () => {
  it('keeps the Chinese body byte-identical and adds an English variant', () => {
    const counts = { session_completed: 3, session_partial: 1, missed_training: 2, pr_e1rm: 1 };
    expect(dailyDigestBody(counts)).toBe('昨天：3 练完 · 1 部分完成 · 2 缺练 · 1 破 PR');
    expect(dailyDigestBody(counts, 'en')).toBe('Yesterday: 3 done · 1 partial · 2 missed · 1 PR');
    expect(
      dailyDigestBody(
        { session_completed: 0, session_partial: 0, missed_training: 0, pr_e1rm: 2 },
        'en',
      ),
    ).toBe('Yesterday: 2 PRs');
    expect(
      dailyDigestBody(
        { session_completed: 0, session_partial: 0, missed_training: 0, pr_e1rm: 0 },
        'en',
      ),
    ).toBeNull();
  });
});
