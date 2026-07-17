import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { SIGNAL_POLICY } from '../src/domain/signal-policy';
import { recordSetLogActivity } from '../src/handlers/activity-ledger';
import { detectSetLogFailure } from '../src/handlers/failure-detection';
import { createPublishedPlan, ids, makeContext, type TestContext } from './helpers/studentActions';

const DAY_MS = 24 * 60 * 60 * 1000;
const LOGGED_AT = new Date('2026-07-16T00:00:00.000Z');

async function makeFailureContext(): Promise<TestContext> {
  const ctx = await makeContext();
  await sql`
    CREATE UNIQUE INDEX student_signals_open_unique_idx
      ON student_signals (student_id, coach_id, signal_type)
      WHERE status = 'open'
  `.execute(ctx.db);
  return ctx;
}

async function insertLog(
  ctx: TestContext,
  input: {
    id?: string;
    studentId?: string;
    planExerciseId: string | null;
    setIndex?: number;
    weightKg?: number;
    reps?: number;
    completed?: boolean;
    failed?: boolean;
    assumed?: boolean;
    loggedAt?: Date;
  },
): Promise<string> {
  const id = input.id ?? randomUUID();
  const loggedAt = input.loggedAt ?? LOGGED_AT;
  await ctx.db
    .insertInto('set_logs')
    .values({
      id,
      student_id: input.studentId ?? ids.trainee,
      plan_exercise_id: input.planExerciseId,
      exercise_id: ids.exercise,
      set_index: input.setIndex ?? 0,
      weight_kg: String(input.weightKg ?? 120),
      reps: input.reps ?? 3,
      completed: input.completed ?? false,
      failed: input.failed ?? true,
      assumed: input.assumed ?? false,
      adhoc: input.planExerciseId === null,
      logged_date: loggedAt.toISOString().slice(0, 10),
      logged_at: loggedAt,
    })
    .execute();
  return id;
}

async function detect(
  ctx: TestContext,
  studentId: string,
  setLogId: string,
  now: Date = LOGGED_AT,
): Promise<void> {
  await ctx.db.transaction().execute((trx) => detectSetLogFailure(trx, studentId, setLogId, now));
}

function payload(value: Record<string, unknown> | string): Record<string, unknown> {
  return typeof value === 'string' ? (JSON.parse(value) as Record<string, unknown>) : value;
}

describe('detectSetLogFailure', () => {
  it('records a main-lift failed set and opens one yellow coach signal', async () => {
    const ctx = await makeFailureContext();
    const plan = await createPublishedPlan(ctx);
    const setLogId = await insertLog(ctx, {
      planExerciseId: plan.planExerciseId,
      setIndex: 2,
      weightKg: 120,
      reps: 3,
    });
    const openedAt = new Date('2026-07-16T00:01:00.000Z');

    await detect(ctx, ids.trainee, setLogId, openedAt);

    const event = await ctx.db
      .selectFrom('student_events')
      .selectAll()
      .where('event_type', '=', 'set_failed')
      .executeTakeFirstOrThrow();
    expect(event).toMatchObject({
      student_id: ids.trainee,
      coach_id: ids.coach,
      dedup_key: `fail:${ids.trainee}:${setLogId}`,
      occurred_at: LOGGED_AT,
    });
    expect(payload(event.payload)).toEqual({
      set_log_id: setLogId,
      exercise_id: ids.exercise,
      weight_kg: 120,
      reps: 3,
      set_index: 2,
      logged_date: '2026-07-16',
    });

    const signal = await ctx.db.selectFrom('student_signals').selectAll().executeTakeFirstOrThrow();
    expect(signal).toMatchObject({
      student_id: ids.trainee,
      coach_id: ids.coach,
      signal_type: 'weight_failed',
      severity: 'yellow',
      status: 'open',
      reason: 'Competition Squat 120kg 未完成',
      opened_at: openedAt,
    });
    expect(payload(signal.payload)).toEqual({ gym_day: '2026-07-16', failed_count: 1 });
    expect(signal.expires_at).toEqual(
      new Date(openedAt.getTime() + SIGNAL_POLICY.signalExpiryDays * DAY_MS),
    );
  });

  it.each([
    { name: 'accessory plan exercise', kind: 'accessory' },
    { name: 'adhoc set', kind: 'adhoc' },
    { name: 'assumed history', kind: 'assumed' },
    { name: 'completed but not failed', kind: 'completed' },
  ])('ignores $name', async ({ kind }) => {
    const ctx = await makeFailureContext();
    const plan = await createPublishedPlan(ctx);
    if (kind === 'accessory') {
      await ctx.db
        .updateTable('plan_exercises')
        .set({ is_main_lift: false })
        .where('id', '=', plan.planExerciseId)
        .execute();
    }
    const setLogId = await insertLog(ctx, {
      planExerciseId: kind === 'adhoc' ? null : plan.planExerciseId,
      assumed: kind === 'assumed',
      completed: kind === 'completed',
      failed: kind !== 'completed',
    });

    await detect(ctx, ids.trainee, setLogId);

    expect(await ctx.db.selectFrom('student_events').selectAll().execute()).toEqual([]);
    expect(await ctx.db.selectFrom('student_signals').selectAll().execute()).toEqual([]);
  });

  it('is idempotent when the same set-log hook is replayed', async () => {
    const ctx = await makeFailureContext();
    const plan = await createPublishedPlan(ctx);
    const setLogId = await insertLog(ctx, { planExerciseId: plan.planExerciseId });

    await detect(ctx, ids.trainee, setLogId);
    await detect(ctx, ids.trainee, setLogId, new Date('2026-07-16T00:05:00.000Z'));

    expect(await ctx.db.selectFrom('student_events').selectAll().execute()).toHaveLength(1);
    const signal = await ctx.db.selectFrom('student_signals').selectAll().executeTakeFirstOrThrow();
    expect(payload(signal.payload)).toEqual({ gym_day: '2026-07-16', failed_count: 1 });
  });

  it('merges same-day failures and refreshes the latest reason, count, and expiry', async () => {
    const ctx = await makeFailureContext();
    const plan = await createPublishedPlan(ctx);
    const firstId = await insertLog(ctx, {
      planExerciseId: plan.planExerciseId,
      setIndex: 0,
      weightKg: 115,
    });
    const secondId = await insertLog(ctx, {
      planExerciseId: plan.planExerciseId,
      setIndex: 1,
      weightKg: 120,
    });
    const firstNow = new Date('2026-07-16T00:01:00.000Z');
    const secondNow = new Date('2026-07-16T00:05:00.000Z');

    await detect(ctx, ids.trainee, firstId, firstNow);
    await detect(ctx, ids.trainee, secondId, secondNow);

    expect(await ctx.db.selectFrom('student_events').selectAll().execute()).toHaveLength(2);
    const signals = await ctx.db.selectFrom('student_signals').selectAll().execute();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.reason).toBe('Competition Squat 120kg 未完成（今日第 2 次）');
    expect(payload(signals[0]?.payload ?? {})).toEqual({
      gym_day: '2026-07-16',
      failed_count: 2,
    });
    expect(signals[0]?.opened_at).toEqual(firstNow);
    expect(signals[0]?.expires_at).toEqual(
      new Date(secondNow.getTime() + SIGNAL_POLICY.signalExpiryDays * DAY_MS),
    );
  });

  it('renews a stale open signal from an earlier day in place instead of colliding', async () => {
    const ctx = await makeFailureContext();
    const plan = await createPublishedPlan(ctx);
    // Yesterday's failure opened a signal that never left the board.
    const yesterdayId = await insertLog(ctx, {
      planExerciseId: plan.planExerciseId,
      setIndex: 0,
      weightKg: 115,
      loggedAt: new Date('2026-07-15T00:01:00.000Z'),
    });
    await detect(ctx, ids.trainee, yesterdayId, new Date('2026-07-15T00:01:30.000Z'));

    // Today's failure must renew that open row (insert would hit the open
    // partial unique index and roll back the set_failed fact event).
    const todayId = await insertLog(ctx, {
      planExerciseId: plan.planExerciseId,
      setIndex: 1,
      weightKg: 120,
      loggedAt: new Date('2026-07-16T00:02:00.000Z'),
    });
    const todayNow = new Date('2026-07-16T00:02:30.000Z');
    await detect(ctx, ids.trainee, todayId, todayNow);

    expect(await ctx.db.selectFrom('student_events').selectAll().execute()).toHaveLength(2);
    const signals = await ctx.db.selectFrom('student_signals').selectAll().execute();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.status).toBe('open');
    expect(signals[0]?.reason).toBe('Competition Squat 120kg 未完成');
    expect(payload(signals[0]?.payload ?? {})).toEqual({
      gym_day: '2026-07-16',
      failed_count: 1,
    });
    expect(signals[0]?.opened_at).toEqual(todayNow);
  });

  it('keeps the fact event but never regresses the signal on a backdated failure', async () => {
    const ctx = await makeFailureContext();
    const plan = await createPublishedPlan(ctx);
    const todayId = await insertLog(ctx, {
      planExerciseId: plan.planExerciseId,
      setIndex: 0,
      weightKg: 120,
      loggedAt: new Date('2026-07-16T00:02:00.000Z'),
    });
    await detect(ctx, ids.trainee, todayId, new Date('2026-07-16T00:02:30.000Z'));

    // Backdated failed set for an EARLIER day: fact recorded, signal untouched.
    const backdatedId = await insertLog(ctx, {
      planExerciseId: plan.planExerciseId,
      setIndex: 1,
      weightKg: 110,
      loggedAt: new Date('2026-07-15T00:01:00.000Z'),
    });
    await detect(ctx, ids.trainee, backdatedId, new Date('2026-07-16T00:03:00.000Z'));

    expect(await ctx.db.selectFrom('student_events').selectAll().execute()).toHaveLength(2);
    const signals = await ctx.db.selectFrom('student_signals').selectAll().execute();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.reason).toBe('Competition Squat 120kg 未完成');
    expect(payload(signals[0]?.payload ?? {})).toEqual({
      gym_day: '2026-07-16',
      failed_count: 1,
    });
  });

  it('writes only the fact event when no coach can be attributed', async () => {
    const ctx = await makeFailureContext();
    const plan = await createPublishedPlan(ctx, ids.coach, ids.selfTrainStudent);
    await ctx.db
      .updateTable('plans')
      .set({ coach_id: null })
      .where('id', '=', plan.planId)
      .execute();
    const setLogId = await insertLog(ctx, {
      studentId: ids.selfTrainStudent,
      planExerciseId: plan.planExerciseId,
    });

    await detect(ctx, ids.selfTrainStudent, setLogId);

    const event = await ctx.db.selectFrom('student_events').selectAll().executeTakeFirstOrThrow();
    expect(event.coach_id).toBeNull();
    expect(await ctx.db.selectFrom('student_signals').selectAll().execute()).toEqual([]);
  });

  it('runs from the ledger hook and attributes plan-coach before bond fallback', async () => {
    const ctx = await makeFailureContext();
    const plan = await createPublishedPlan(ctx, ids.otherCoach);
    const setLogId = await insertLog(ctx, { planExerciseId: plan.planExerciseId });
    const openedAt = new Date('2026-07-16T00:01:00.000Z');

    await recordSetLogActivity(ctx.db, ids.trainee, setLogId, openedAt);

    const event = await ctx.db
      .selectFrom('student_events')
      .selectAll()
      .where('event_type', '=', 'set_failed')
      .executeTakeFirstOrThrow();
    const signal = await ctx.db
      .selectFrom('student_signals')
      .selectAll()
      .where('signal_type', '=', 'weight_failed')
      .executeTakeFirstOrThrow();
    expect(event.coach_id).toBe(ids.otherCoach);
    expect(signal.coach_id).toBe(ids.otherCoach);
  });
});
