import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { recordSetLogActivity } from '../src/handlers/activity-ledger';
import { detectSetLogPr } from '../src/handlers/pr-detection';
import { SIGNAL_POLICY } from '../src/domain/signal-policy';
import { createPublishedPlan, ids, makeContext, type TestContext } from './helpers/studentActions';

const DAY_MS = 24 * 60 * 60 * 1000;
const TRIGGER_AT = new Date('2026-07-10T00:00:00.000Z');
const BENCH_EXERCISE_ID = '20000000-0000-4000-8000-000000000002';

interface LogFixture {
  id: string;
  studentId?: string;
  exerciseId?: string;
  planExerciseId?: string | null;
  loggedAt: Date;
  setIndex: number;
  weightKg?: number;
  reps?: number;
  rpe?: number | null;
  completed?: boolean;
  failed?: boolean;
  assumed?: boolean;
  confidence?: 'normal' | 'low' | null;
}

async function makePrContext(): Promise<TestContext> {
  const ctx = await makeContext();
  // The shared harness mirrors the table but intentionally omits indexes.
  // Add migration 0041's partial unique index for the PR signal contract.
  await sql`
    CREATE UNIQUE INDEX student_signals_open_unique_idx
      ON student_signals (student_id, coach_id, signal_type)
      WHERE status = 'open'
  `.execute(ctx.db);
  return ctx;
}

function loggedDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function daysBefore(days: number): Date {
  return new Date(TRIGGER_AT.getTime() - days * DAY_MS);
}

async function insertLog(ctx: TestContext, fixture: LogFixture): Promise<void> {
  const planExerciseId = fixture.planExerciseId ?? null;
  await ctx.db
    .insertInto('set_logs')
    .values({
      id: fixture.id,
      student_id: fixture.studentId ?? ids.trainee,
      plan_exercise_id: planExerciseId,
      exercise_id: fixture.exerciseId ?? ids.exercise,
      set_index: fixture.setIndex,
      weight_kg: String(fixture.weightKg ?? 100),
      reps: fixture.reps ?? 1,
      rpe:
        fixture.rpe === undefined ? '10.0' : fixture.rpe === null ? null : fixture.rpe.toFixed(1),
      completed: fixture.completed ?? true,
      failed: fixture.failed ?? false,
      assumed: fixture.assumed ?? false,
      adhoc: planExerciseId === null,
      e1rm_confidence: fixture.confidence ?? 'normal',
      logged_date: loggedDate(fixture.loggedAt),
      logged_at: fixture.loggedAt,
    })
    .execute();
}

async function detect(ctx: TestContext, setLogId: string, now = TRIGGER_AT): Promise<void> {
  await ctx.db.transaction().execute((trx) => detectSetLogPr(trx, ids.trainee, setLogId, now));
}

function payload(value: Record<string, unknown> | string): Record<string, unknown> {
  return typeof value === 'string' ? (JSON.parse(value) as Record<string, unknown>) : value;
}

async function prRows(ctx: TestContext) {
  return ctx.db
    .selectFrom('student_events')
    .selectAll()
    .where('event_type', '=', 'pr_e1rm')
    .execute();
}

describe('detectSetLogPr', () => {
  it.each([
    { name: 'RPE below 7', trigger: { rpe: 6.5 } },
    { name: 'low confidence', trigger: { confidence: 'low' as const } },
    { name: 'more than 10 reps', trigger: { reps: 11 } },
    { name: 'more than 5 deadlift reps', trigger: { reps: 6 }, deadlift: true },
    { name: 'failed', trigger: { failed: true } },
    { name: 'incomplete', trigger: { completed: false } },
    { name: 'non-positive weight', trigger: { weightKg: 0 } },
    { name: 'assumed history', trigger: { assumed: true } },
    { name: 'unresolved competition family', trigger: {}, unresolvedFamily: true },
  ])('rejects an otherwise-PR set when $name', async ({ trigger, deadlift, unresolvedFamily }) => {
    const ctx = await makePrContext();
    if (deadlift) {
      await ctx.db
        .updateTable('exercises')
        .set({ name: '竞技硬拉', main_lift_family: 'deadlift' })
        .where('id', '=', ids.exercise)
        .execute();
    }
    if (unresolvedFamily) {
      await ctx.db
        .updateTable('exercises')
        .set({ is_competition_lift: false })
        .where('id', '=', ids.exercise)
        .execute();
    }

    await insertLog(ctx, {
      id: '31000000-0000-4000-8000-000000000001',
      loggedAt: daysBefore(1),
      setIndex: 0,
      weightKg: 100,
    });
    const triggerId = '31000000-0000-4000-8000-000000000002';
    await insertLog(ctx, {
      id: triggerId,
      loggedAt: TRIGGER_AT,
      setIndex: 1,
      weightKg: 150,
      ...trigger,
    });

    await detect(ctx, triggerId);

    expect(await prRows(ctx)).toHaveLength(0);
    expect(await ctx.db.selectFrom('student_signals').selectAll().execute()).toHaveLength(0);
  });

  it('excludes assumed baselines while retaining the real eligible best', async () => {
    const ctx = await makePrContext();
    await insertLog(ctx, {
      id: '31000000-0000-4000-8000-000000000003',
      loggedAt: daysBefore(10),
      setIndex: 0,
      weightKg: 100,
    });
    await insertLog(ctx, {
      id: '31000000-0000-4000-8000-000000000004',
      loggedAt: daysBefore(5),
      setIndex: 0,
      weightKg: 200,
      assumed: true,
    });
    const triggerId = '31000000-0000-4000-8000-000000000005';
    await insertLog(ctx, {
      id: triggerId,
      loggedAt: TRIGGER_AT,
      setIndex: 1,
      weightKg: 104,
    });

    await detect(ctx, triggerId);

    const event = (await prRows(ctx))[0];
    expect(event).toBeDefined();
    expect(payload(event?.payload ?? {}).previous_best).toBe(100);
  });

  it('anchors the rolling window at logged_at and ignores a 29-day-old best', async () => {
    const ctx = await makePrContext();
    await insertLog(ctx, {
      id: '31000000-0000-4000-8000-000000000006',
      loggedAt: daysBefore(29),
      setIndex: 0,
      weightKg: 200,
    });
    await insertLog(ctx, {
      id: '31000000-0000-4000-8000-000000000007',
      loggedAt: daysBefore(10),
      setIndex: 0,
      weightKg: 100,
    });
    const triggerId = '31000000-0000-4000-8000-000000000008';
    await insertLog(ctx, {
      id: triggerId,
      loggedAt: TRIGGER_AT,
      setIndex: 1,
      weightKg: 104,
    });

    await detect(ctx, triggerId);

    const event = (await prRows(ctx))[0];
    expect(event).toBeDefined();
    expect(payload(event?.payload ?? {})).toMatchObject({
      e1rm: 104,
      previous_best: 100,
      logged_date: '2026-07-10',
    });
  });

  it.each([
    { increase: 'inside +2%', weightKg: 102, expectedEvents: 0 },
    { increase: 'outside +4%', weightKg: 104, expectedEvents: 1 },
  ])(
    '$increase of the noise band yields $expectedEvents PR event(s)',
    async ({ weightKg, expectedEvents }) => {
      const ctx = await makePrContext();
      await insertLog(ctx, {
        id: '31000000-0000-4000-8000-000000000009',
        loggedAt: daysBefore(1),
        setIndex: 0,
        weightKg: 100,
      });
      const triggerId = '31000000-0000-4000-8000-000000000010';
      await insertLog(ctx, {
        id: triggerId,
        loggedAt: TRIGGER_AT,
        setIndex: 1,
        weightKg,
      });

      await detect(ctx, triggerId);

      expect(await prRows(ctx)).toHaveLength(expectedEvents);
    },
  );

  it('treats the first eligible set as baseline only', async () => {
    const ctx = await makePrContext();
    const triggerId = '31000000-0000-4000-8000-000000000011';
    await insertLog(ctx, {
      id: triggerId,
      loggedAt: TRIGGER_AT,
      setIndex: 0,
      weightKg: 180,
    });

    await detect(ctx, triggerId);

    expect(await prRows(ctx)).toHaveLength(0);
    expect(await ctx.db.selectFrom('student_signals').selectAll().execute()).toHaveLength(0);
  });

  it('is idempotent when the same set-log hook is replayed', async () => {
    const ctx = await makePrContext();
    await insertLog(ctx, {
      id: '31000000-0000-4000-8000-000000000012',
      loggedAt: daysBefore(1),
      setIndex: 0,
      weightKg: 100,
    });
    const triggerId = '31000000-0000-4000-8000-000000000013';
    await insertLog(ctx, {
      id: triggerId,
      loggedAt: TRIGGER_AT,
      setIndex: 1,
      weightKg: 104,
    });
    const firstOpenedAt = new Date('2026-07-10T01:00:00.000Z');

    await detect(ctx, triggerId, firstOpenedAt);
    await detect(ctx, triggerId, new Date('2026-07-10T02:00:00.000Z'));

    const events = await prRows(ctx);
    const signals = await ctx.db.selectFrom('student_signals').selectAll().execute();
    expect(events).toHaveLength(1);
    expect(events[0]?.dedup_key).toBe(`pr:${ids.trainee}:squat:${triggerId}`);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.opened_at).toEqual(firstOpenedAt);
  });

  it('updates one open congrats row, keeps its higher payload, and refreshes expiry', async () => {
    const ctx = await makePrContext();
    await ctx.db
      .insertInto('exercises')
      .values({
        id: BENCH_EXERCISE_ID,
        name: '竞技卧推',
        exercise_type: 'main_lift',
        main_lift_family: 'bench',
        is_competition_lift: true,
        muscle_groups: ['chest'],
        equipment: ['barbell'],
        movement_pattern: [],
      })
      .execute();
    await insertLog(ctx, {
      id: '31000000-0000-4000-8000-000000000014',
      loggedAt: daysBefore(3),
      setIndex: 0,
      weightKg: 100,
    });
    await insertLog(ctx, {
      id: '31000000-0000-4000-8000-000000000015',
      exerciseId: BENCH_EXERCISE_ID,
      loggedAt: daysBefore(2),
      setIndex: 0,
      weightKg: 80,
    });
    const firstPrId = '31000000-0000-4000-8000-000000000016';
    await insertLog(ctx, {
      id: firstPrId,
      loggedAt: daysBefore(1),
      setIndex: 0,
      weightKg: 104,
    });
    const higherPrId = '31000000-0000-4000-8000-000000000017';
    await insertLog(ctx, {
      id: higherPrId,
      loggedAt: TRIGGER_AT,
      setIndex: 1,
      weightKg: 110,
    });
    const lowerBenchPrId = '31000000-0000-4000-8000-000000000018';
    await insertLog(ctx, {
      id: lowerBenchPrId,
      exerciseId: BENCH_EXERCISE_ID,
      loggedAt: new Date(TRIGGER_AT.getTime() + DAY_MS),
      setIndex: 1,
      weightKg: 84,
    });

    await detect(ctx, firstPrId, new Date('2026-07-10T01:00:00.000Z'));
    await detect(ctx, higherPrId, new Date('2026-07-10T02:00:00.000Z'));
    const refreshedAt = new Date('2026-07-11T03:00:00.000Z');
    await detect(ctx, lowerBenchPrId, refreshedAt);

    const signals = await ctx.db.selectFrom('student_signals').selectAll().execute();
    expect(signals).toHaveLength(1);
    expect(payload(signals[0]?.payload ?? {})).toMatchObject({
      set_log_id: higherPrId,
      family: 'squat',
      e1rm: 110,
      previous_best: 104,
    });
    expect(signals[0]?.reason).toBe('深蹲 e1RM 新高 110.0kg（此前最好 104.0kg）');
    expect(signals[0]?.opened_at).toEqual(refreshedAt);
    expect(signals[0]?.expires_at).toEqual(
      new Date(refreshedAt.getTime() + SIGNAL_POLICY.signalExpiryDays * DAY_MS),
    );
  });

  it('writes only the fact event when the student has no attributable coach', async () => {
    const ctx = await makePrContext();
    await insertLog(ctx, {
      id: '31000000-0000-4000-8000-000000000019',
      studentId: ids.selfTrainStudent,
      loggedAt: daysBefore(1),
      setIndex: 0,
      weightKg: 100,
    });
    const triggerId = '31000000-0000-4000-8000-000000000020';
    await insertLog(ctx, {
      id: triggerId,
      studentId: ids.selfTrainStudent,
      loggedAt: TRIGGER_AT,
      setIndex: 1,
      weightKg: 104,
    });

    await ctx.db
      .transaction()
      .execute((trx) => detectSetLogPr(trx, ids.selfTrainStudent, triggerId, TRIGGER_AT));

    const event = await ctx.db
      .selectFrom('student_events')
      .selectAll()
      .where('event_type', '=', 'pr_e1rm')
      .executeTakeFirstOrThrow();
    expect(event.coach_id).toBeNull();
    expect(await ctx.db.selectFrom('student_signals').selectAll().execute()).toHaveLength(0);
  });

  it('hooks after session recompute and attributes the PR to the plan author', async () => {
    const ctx = await makePrContext();
    const plan = await createPublishedPlan(ctx, ids.otherCoach);
    await insertLog(ctx, {
      id: '31000000-0000-4000-8000-000000000021',
      loggedAt: new Date('2026-07-09T00:00:00.000Z'),
      setIndex: 0,
      weightKg: 100,
    });
    const triggerId = '31000000-0000-4000-8000-000000000022';
    await insertLog(ctx, {
      id: triggerId,
      planExerciseId: plan.planExerciseId,
      loggedAt: new Date('2026-07-10T00:00:00.000Z'),
      setIndex: 0,
      weightKg: 104,
    });
    const openedAt = new Date('2026-07-10T00:01:00.000Z');

    await recordSetLogActivity(ctx.db, ids.trainee, triggerId, openedAt);

    const event = await ctx.db
      .selectFrom('student_events')
      .selectAll()
      .where('event_type', '=', 'pr_e1rm')
      .executeTakeFirstOrThrow();
    const signal = await ctx.db.selectFrom('student_signals').selectAll().executeTakeFirstOrThrow();
    expect(event.coach_id).toBe(ids.otherCoach);
    expect(signal.coach_id).toBe(ids.otherCoach);
    expect(signal.opened_at).toEqual(openedAt);
  });

  it.each([
    { name: 'exactly +3% is inside the band', baseline: 100, trigger: 103, hits: false },
    { name: 'strictly over +3% clears the band', baseline: 100, trigger: 103.1, hits: true },
    {
      name: 'the 0.5kg floor rejects exactly +0.5kg on a low baseline',
      baseline: 10,
      trigger: 10.5,
      hits: false,
    },
    {
      name: 'strictly over the 0.5kg floor hits on a low baseline',
      baseline: 10,
      trigger: 10.6,
      hits: true,
    },
  ])('noise band: $name', async ({ baseline, trigger, hits }) => {
    const ctx = await makePrContext();
    await insertLog(ctx, {
      id: '30000000-0000-4000-8000-000000000101',
      loggedAt: daysBefore(3),
      setIndex: 0,
      weightKg: baseline,
    });
    const triggerId = '30000000-0000-4000-8000-000000000102';
    await insertLog(ctx, { id: triggerId, loggedAt: TRIGGER_AT, setIndex: 1, weightKg: trigger });

    await detect(ctx, triggerId);

    expect((await prRows(ctx)).length).toBe(hits ? 1 : 0);
  });

  it('includes a candidate exactly 28 days before the trigger in the baseline', async () => {
    const ctx = await makePrContext();
    await insertLog(ctx, {
      id: '30000000-0000-4000-8000-000000000103',
      loggedAt: daysBefore(28),
      setIndex: 0,
      weightKg: 150,
    });
    const triggerId = '30000000-0000-4000-8000-000000000104';
    await insertLog(ctx, { id: triggerId, loggedAt: TRIGGER_AT, setIndex: 1, weightKg: 160 });

    await detect(ctx, triggerId);

    const rows = await prRows(ctx);
    expect(rows.length).toBe(1);
    expect(payload(rows[0]?.payload ?? {}).previous_best).toBe(150);
  });

  it('anchors the window on the trigger logged_at, not on processing time', async () => {
    const ctx = await makePrContext();
    // Inside [logged_at - 28d, logged_at) but OUTSIDE a window anchored on the
    // (later) processing time — if the anchor ever drifts to `now`, this
    // baseline disappears and no PR fires.
    await insertLog(ctx, {
      id: '30000000-0000-4000-8000-000000000105',
      loggedAt: daysBefore(27),
      setIndex: 0,
      weightKg: 120,
    });
    const triggerId = '30000000-0000-4000-8000-000000000106';
    await insertLog(ctx, { id: triggerId, loggedAt: TRIGGER_AT, setIndex: 1, weightKg: 130 });

    await detect(ctx, triggerId, new Date(TRIGGER_AT.getTime() + 5 * DAY_MS));

    const rows = await prRows(ctx);
    expect(rows.length).toBe(1);
    expect(payload(rows[0]?.payload ?? {}).previous_best).toBe(120);
  });
});
