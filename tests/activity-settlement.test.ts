import { randomUUID } from 'node:crypto';

import type { Kysely } from 'kysely';
import { describe, expect, it, vi } from 'vitest';

import type { Database } from '../src/db/types';
import { runDailySettlement, runSessionSweep } from '../src/jobs/activity-settlement';
import { ids, makeContext, createPublishedPlan, type TestContext } from './helpers/studentActions';

function payload(value: Record<string, unknown> | string): Record<string, unknown> {
  return typeof value === 'string' ? (JSON.parse(value) as Record<string, unknown>) : value;
}

async function addPlanDays(
  db: Kysely<Database>,
  planId: string,
  dayOfWeeks: number[],
): Promise<void> {
  await db
    .insertInto('plan_days')
    .values(
      dayOfWeeks.map((dayOfWeek) => ({
        plan_id: planId,
        day_of_week: dayOfWeek,
        week_number: 1,
        sort_order: dayOfWeek,
      })),
    )
    .execute();
}

async function insertAdhocLog(
  ctx: TestContext,
  input: {
    studentId?: string;
    loggedDate: string;
    loggedAt?: Date;
    assumed?: boolean;
    failed?: boolean;
  },
): Promise<void> {
  await ctx.db
    .insertInto('set_logs')
    .values({
      id: randomUUID(),
      student_id: input.studentId ?? ids.trainee,
      plan_exercise_id: null,
      exercise_id: ids.exercise,
      set_index: 0,
      weight_kg: '0.00',
      reps: 1,
      completed: false,
      failed: input.failed ?? true,
      assumed: input.assumed ?? false,
      adhoc: true,
      logged_date: input.loggedDate,
      logged_at: input.loggedAt ?? new Date(`${input.loggedDate}T12:00:00Z`),
    })
    .execute();
}

describe('daily activity settlement', () => {
  it('opens one missed-training signal, grows the same streak, and never reopens a closed streak', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await addPlanDays(ctx.db, plan.planId, [2, 3, 4, 5]);

    const firstNow = new Date('2026-05-03T20:05:00Z');
    await runDailySettlement(ctx.db, '2026-05-03', firstNow);
    await runDailySettlement(ctx.db, '2026-05-03', new Date('2026-05-03T21:05:00Z'));

    const first = await ctx.db
      .selectFrom('student_signals')
      .selectAll()
      .where('signal_type', '=', 'missed_training')
      .executeTakeFirstOrThrow();
    expect(first.reason).toBe('连续 3 个训练日未打卡（5-1 / 5-2 / 5-3）');
    expect(payload(first.payload)).toEqual({
      missed_dates: ['2026-05-01', '2026-05-02', '2026-05-03'],
      consecutive_count: 3,
      plan_id: plan.planId,
      streak_start_date: '2026-05-01',
      absence_epoch: 'never',
    });
    expect(first.expires_at).toEqual(new Date('2026-05-10T20:05:00Z'));

    const grownNow = new Date('2026-05-04T20:05:00Z');
    await runDailySettlement(ctx.db, '2026-05-04', grownNow);
    const grown = await ctx.db
      .selectFrom('student_signals')
      .selectAll()
      .where('signal_type', '=', 'missed_training')
      .execute();
    expect(grown).toHaveLength(1);
    const grownSignal = grown[0];
    if (grownSignal === undefined) throw new Error('expected the grown signal');
    expect(grownSignal).toMatchObject({ id: first.id, opened_at: first.opened_at, status: 'open' });
    expect(payload(grownSignal.payload)).toMatchObject({
      consecutive_count: 4,
      streak_start_date: '2026-05-01',
    });
    expect(grownSignal.expires_at).toEqual(new Date('2026-05-11T20:05:00Z'));

    // Same-plan rerun of the older 5-03 gym-day must not shrink count 4 → 3.
    await runDailySettlement(ctx.db, '2026-05-03', new Date('2026-05-04T20:35:00Z'));
    const afterRerun = await ctx.db
      .selectFrom('student_signals')
      .selectAll()
      .where('signal_type', '=', 'missed_training')
      .executeTakeFirstOrThrow();
    expect(payload(afterRerun.payload)).toMatchObject({ consecutive_count: 4 });

    await ctx.db
      .updateTable('student_signals')
      .set({ status: 'acked', acked_at: grownNow })
      .where('id', '=', first.id)
      .execute();
    await runDailySettlement(ctx.db, '2026-05-05', new Date('2026-05-05T20:05:00Z'));
    expect(
      await ctx.db
        .selectFrom('student_signals')
        .select('id')
        .where('signal_type', '=', 'missed_training')
        .execute(),
    ).toHaveLength(1);
  });

  it('follows the per-coach winner plan within one absence epoch and stays acked after ack', async () => {
    const ctx = await makeContext();
    // Same coach, two plans: A schedules 5-01/5-02/5-03, B schedules 5-01 and
    // 5-03/5-04/5-05. The student never trains (absence epoch 'never').
    const planA = await createPublishedPlan(ctx);
    await addPlanDays(ctx.db, planA.planId, [2, 3]);
    const planB = await createPublishedPlan(ctx);
    await addPlanDays(ctx.db, planB.planId, [3, 4, 5]);

    // 5-03: only plan A reaches the threshold (3 misses vs B's 2).
    await runDailySettlement(ctx.db, '2026-05-03', new Date('2026-05-03T20:05:00Z'));
    const opened = await ctx.db
      .selectFrom('student_signals')
      .selectAll()
      .where('signal_type', '=', 'missed_training')
      .executeTakeFirstOrThrow();
    expect(payload(opened.payload)).toMatchObject({ plan_id: planA.planId, consecutive_count: 3 });

    // 5-04 is a rest day for plan A; plan B now has 3 misses and becomes the
    // winner. Same epoch — the OPEN row must switch to B, not spawn a second.
    await runDailySettlement(ctx.db, '2026-05-04', new Date('2026-05-04T20:05:00Z'));
    const switched = await ctx.db
      .selectFrom('student_signals')
      .selectAll()
      .where('signal_type', '=', 'missed_training')
      .execute();
    expect(switched).toHaveLength(1);
    expect(switched[0]).toMatchObject({ id: opened.id, status: 'open' });
    expect(payload(switched[0]?.payload ?? {})).toMatchObject({
      plan_id: planB.planId,
      consecutive_count: 3,
      absence_epoch: 'never',
    });

    // Same-epoch rerun of the OLDER 5-03 gym-day (where plan A was the
    // winner) must not roll the open row back from B to A.
    await runDailySettlement(ctx.db, '2026-05-03', new Date('2026-05-04T20:35:00Z'));
    const afterRerun = await ctx.db
      .selectFrom('student_signals')
      .selectAll()
      .where('signal_type', '=', 'missed_training')
      .executeTakeFirstOrThrow();
    expect(payload(afterRerun.payload)).toMatchObject({
      plan_id: planB.planId,
      consecutive_count: 3,
    });

    // Coach acks. The absence epoch has not ended (still no training), so a
    // longer plan-B streak must NOT reopen or insert a new row.
    await ctx.db
      .updateTable('student_signals')
      .set({ status: 'acked', acked_at: new Date('2026-05-04T21:00:00Z') })
      .where('id', '=', opened.id)
      .execute();
    await runDailySettlement(ctx.db, '2026-05-05', new Date('2026-05-05T20:05:00Z'));
    const afterAck = await ctx.db
      .selectFrom('student_signals')
      .selectAll()
      .where('signal_type', '=', 'missed_training')
      .execute();
    expect(afterAck).toHaveLength(1);
    expect(afterAck[0]).toMatchObject({ id: opened.id, status: 'acked' });
  });

  it('ignores a historical rerun older than the open epoch and keeps its signal open', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await addPlanDays(ctx.db, plan.planId, [2, 3, 4, 5, 6, 7]);
    // Trained only on 5-04: settling 5-07 opens an epoch-2026-05-04 signal
    // for the 5-05/5-06/5-07 misses.
    await insertAdhocLog(ctx, { loggedDate: '2026-05-04' });
    await runDailySettlement(ctx.db, '2026-05-07', new Date('2026-05-07T20:05:00Z'));
    const opened = await ctx.db
      .selectFrom('student_signals')
      .selectAll()
      .where('signal_type', '=', 'missed_training')
      .executeTakeFirstOrThrow();
    expect(payload(opened.payload)).toMatchObject({ absence_epoch: '2026-05-04' });

    // Manual rerun of 5-03 (epoch 'never', 3 misses) is older than the open
    // epoch: it must neither close the open signal nor insert a stale row.
    await runDailySettlement(ctx.db, '2026-05-03', new Date('2026-05-07T21:05:00Z'));
    // Rerun of 5-04 (the training day anchoring the open epoch) must not
    // auto-resolve the newer absence either.
    await runDailySettlement(ctx.db, '2026-05-04', new Date('2026-05-07T22:05:00Z'));

    const after = await ctx.db
      .selectFrom('student_signals')
      .selectAll()
      .where('signal_type', '=', 'missed_training')
      .execute();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: opened.id, status: 'open' });
    expect(payload(after[0]?.payload ?? {})).toMatchObject({ absence_epoch: '2026-05-04' });
  });

  it('auto-resolves on any real set and opens a new row only for the later streak', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await addPlanDays(ctx.db, plan.planId, [2, 3, 4, 5, 6, 7]);

    await runDailySettlement(ctx.db, '2026-05-03', new Date('2026-05-03T20:05:00Z'));
    await insertAdhocLog(ctx, { loggedDate: '2026-05-04', failed: true });
    await runDailySettlement(ctx.db, '2026-05-04', new Date('2026-05-04T20:05:00Z'));
    await runDailySettlement(ctx.db, '2026-05-07', new Date('2026-05-07T20:05:00Z'));

    const signals = await ctx.db
      .selectFrom('student_signals')
      .selectAll()
      .where('signal_type', '=', 'missed_training')
      .orderBy('opened_at')
      .execute();
    expect(signals).toHaveLength(2);
    const oldSignal = signals[0];
    const newSignal = signals[1];
    if (oldSignal === undefined || newSignal === undefined) {
      throw new Error('expected old and new streak signals');
    }
    expect(oldSignal).toMatchObject({ status: 'auto_resolved' });
    expect(oldSignal.resolved_at).toEqual(new Date('2026-05-04T20:05:00Z'));
    expect(newSignal).toMatchObject({ status: 'open' });
    expect(payload(newSignal.payload)).toMatchObject({
      missed_dates: ['2026-05-05', '2026-05-06', '2026-05-07'],
      streak_start_date: '2026-05-05',
    });
  });

  it('counts adhoc/failed sets as started, but excludes assumed history', async () => {
    const realCtx = await makeContext();
    const realPlan = await createPublishedPlan(realCtx);
    await addPlanDays(realCtx.db, realPlan.planId, [2, 3]);
    await insertAdhocLog(realCtx, { loggedDate: '2026-05-03', failed: true });
    await runDailySettlement(realCtx.db, '2026-05-03', new Date('2026-05-03T20:05:00Z'));
    expect(await realCtx.db.selectFrom('student_signals').selectAll().execute()).toHaveLength(0);

    const assumedCtx = await makeContext();
    const assumedPlan = await createPublishedPlan(assumedCtx);
    await addPlanDays(assumedCtx.db, assumedPlan.planId, [2, 3]);
    await insertAdhocLog(assumedCtx, {
      loggedDate: '2026-05-03',
      assumed: true,
      failed: true,
    });
    await runDailySettlement(assumedCtx.db, '2026-05-03', new Date('2026-05-03T20:05:00Z'));
    expect(await assumedCtx.db.selectFrom('student_signals').selectAll().execute()).toHaveLength(1);
  });

  it('keeps lazy-overdue incomplete evaluations exempt', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await addPlanDays(ctx.db, plan.planId, [2, 3]);
    await ctx.db
      .insertInto('evaluation_periods')
      .values({
        student_id: ids.trainee,
        coach_id: ids.coach,
        bind_request_id: randomUUID(),
        expected_end_at: new Date('2026-04-01T00:00:00Z'),
        completed_at: null,
      })
      .execute();

    await runDailySettlement(ctx.db, '2026-05-03', new Date('2026-05-03T20:05:00Z'));
    expect(await ctx.db.selectFrom('student_signals').selectAll().execute()).toHaveLength(0);
  });

  it('expires both signal types while auto-resolving a current missed-training signal', async () => {
    const ctx = await makeContext();
    const now = new Date('2026-05-04T20:05:00Z');
    await insertAdhocLog(ctx, { loggedDate: '2026-05-04' });
    await ctx.db
      .insertInto('student_signals')
      .values([
        {
          student_id: ids.trainee,
          coach_id: ids.coach,
          signal_type: 'missed_training',
          severity: 'red',
          status: 'open',
          reason: 'old miss',
          payload: JSON.stringify({
            missed_dates: ['2026-05-01'],
            consecutive_count: 1,
            plan_id: randomUUID(),
            streak_start_date: '2026-05-01',
          }),
          opened_at: new Date('2026-05-01T00:00:00Z'),
          expires_at: new Date('2026-05-10T00:00:00Z'),
        },
        {
          student_id: ids.otherStudent,
          coach_id: ids.coach,
          signal_type: 'pr_congrats',
          severity: 'green',
          status: 'open',
          reason: 'old pr',
          payload: JSON.stringify({}),
          opened_at: new Date('2026-04-01T00:00:00Z'),
          expires_at: new Date('2026-05-01T00:00:00Z'),
        },
      ])
      .execute();

    await runDailySettlement(ctx.db, '2026-05-04', now);
    const signals = await ctx.db
      .selectFrom('student_signals')
      .select(['signal_type', 'status', 'resolved_at'])
      .orderBy('signal_type')
      .execute();
    expect(signals).toEqual([
      { signal_type: 'missed_training', status: 'auto_resolved', resolved_at: now },
      { signal_type: 'pr_congrats', status: 'expired', resolved_at: null },
    ]);
  });

  it('continues with the next student when one student transaction fails', async () => {
    let armed = false;
    let failedOneLock = false;
    const ctx = await makeContext(undefined, {
      afterQuery: (query) => {
        if (armed && !failedOneLock && query.includes('for update') && query.includes('"users"')) {
          failedOneLock = true;
          throw new Error('one student failed');
        }
        return Promise.resolve();
      },
    });
    await ctx.db
      .insertInto('bind_requests')
      .values({
        student_id: ids.otherStudent,
        coach_id: ids.coach,
        status: 'accepted',
        expired_at: new Date('2026-06-01T00:00:00Z'),
      })
      .execute();
    const firstPlan = await createPublishedPlan(ctx);
    const secondPlan = await createPublishedPlan(ctx, ids.coach, ids.otherStudent);
    await addPlanDays(ctx.db, firstPlan.planId, [2, 3]);
    await addPlanDays(ctx.db, secondPlan.planId, [2, 3]);
    armed = true;
    const warn = vi.fn();

    await runDailySettlement(ctx.db, '2026-05-03', new Date('2026-05-03T20:05:00Z'), {
      warn,
    });

    expect(failedOneLock).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ gymDay: '2026-05-03' }),
      'activity_settlement_student_failed',
    );
    expect(await ctx.db.selectFrom('student_signals').selectAll().execute()).toHaveLength(1);
  });
});

describe('session sweep job', () => {
  it('thinly delegates timeout settlement and stays idempotent', async () => {
    const ctx = await makeContext();
    await ctx.db
      .insertInto('training_sessions')
      .values({
        student_id: ids.selfTrainStudent,
        session_date: '2026-05-01',
        status: 'in_progress',
        started_at: new Date('2026-04-30T20:00:00Z'),
        last_set_at: new Date('2026-04-30T20:00:00Z'),
      })
      .execute();
    // A real adhoc set backs the session: zero-set sessions are now deleted
    // by the sweep (spec 020 §2), which a dedicated test covers.
    await insertAdhocLog(ctx, {
      studentId: ids.selfTrainStudent,
      loggedDate: '2026-05-01',
      loggedAt: new Date('2026-04-30T20:00:00Z'),
    });
    const now = new Date('2026-05-01T01:00:01Z');

    await runSessionSweep(ctx.db, now);
    await runSessionSweep(ctx.db, now);

    expect(
      await ctx.db.selectFrom('training_sessions').select(['status', 'completed_at']).execute(),
    ).toEqual([{ status: 'completed', completed_at: now }]);
    expect(await ctx.db.selectFrom('student_events').selectAll().execute()).toHaveLength(1);
  });
});
