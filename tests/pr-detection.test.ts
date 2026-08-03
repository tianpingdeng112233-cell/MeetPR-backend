import { sql } from 'kysely';
import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { SIGNAL_POLICY } from '../src/domain/signal-policy';
import { recordSetLogActivity } from '../src/handlers/activity-ledger';
import { detectSetLogPr } from '../src/handlers/pr-detection';
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
  coachRpe?: number | null;
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

async function registerOneRm(
  ctx: TestContext,
  input: {
    studentId?: string;
    squat?: number;
    bench?: number;
    deadlift?: number;
  },
): Promise<void> {
  await ctx.db
    .insertInto('student_onboarding_profiles')
    .values({
      user_id: input.studentId ?? ids.trainee,
      squat_1rm_kg: input.squat === undefined ? null : String(input.squat),
      bench_1rm_kg: input.bench === undefined ? null : String(input.bench),
      deadlift_1rm_kg: input.deadlift === undefined ? null : String(input.deadlift),
      squat_stance: null,
      deadlift_style: null,
    })
    .execute();
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
      coach_rpe:
        fixture.coachRpe === undefined
          ? null
          : fixture.coachRpe === null
            ? null
            : fixture.coachRpe.toFixed(1),
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

async function detect(
  ctx: TestContext,
  setLogId: string,
  now = TRIGGER_AT,
  studentId = ids.trainee,
): Promise<void> {
  await ctx.db.transaction().execute((trx) => detectSetLogPr(trx, studentId, setLogId, now));
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
  it('uses max(registered 1RM, historical actual weight) and rolls a hit into the baseline', async () => {
    const ctx = await makePrContext();
    await registerOneRm(ctx, { squat: 210 });

    const belowRegistration = '31000000-0000-4000-8000-000000000001';
    await insertLog(ctx, {
      id: belowRegistration,
      loggedAt: daysBefore(2),
      setIndex: 0,
      weightKg: 150,
    });
    await detect(ctx, belowRegistration);
    expect(await prRows(ctx)).toHaveLength(0);

    const hit = '31000000-0000-4000-8000-000000000002';
    await insertLog(ctx, {
      id: hit,
      loggedAt: daysBefore(1),
      setIndex: 1,
      weightKg: 212.5,
    });
    await detect(ctx, hit);

    const belowRolledBaseline = '31000000-0000-4000-8000-000000000003';
    await insertLog(ctx, {
      id: belowRolledBaseline,
      loggedAt: TRIGGER_AT,
      setIndex: 2,
      weightKg: 211,
    });
    await detect(ctx, belowRolledBaseline);

    const events = await prRows(ctx);
    expect(events).toHaveLength(1);
    expect(payload(events[0]?.payload ?? {})).toEqual({
      set_log_id: hit,
      exercise_id: ids.exercise,
      family: 'squat',
      metric: 'actual_weight',
      weight_kg: 212.5,
      previous_best_weight_kg: 210,
      e1rm: 212.5,
      previous_best: 210,
      logged_date: '2026-07-09',
    });
  });

  it('uses the all-time historical actual-weight best when no 1RM is registered', async () => {
    const ctx = await makePrContext();
    await insertLog(ctx, {
      id: '31000000-0000-4000-8000-000000000004',
      loggedAt: daysBefore(90),
      setIndex: 0,
      weightKg: 180,
    });
    const triggerId = '31000000-0000-4000-8000-000000000005';
    await insertLog(ctx, {
      id: triggerId,
      loggedAt: TRIGGER_AT,
      setIndex: 1,
      weightKg: 182.5,
    });

    await detect(ctx, triggerId);

    const event = (await prRows(ctx))[0];
    expect(event).toBeDefined();
    expect(payload(event?.payload ?? {})).toMatchObject({
      weight_kg: 182.5,
      previous_best_weight_kg: 180,
    });
  });

  it('does not let a backfilled older set bypass a known later all-time best', async () => {
    const ctx = await makePrContext();
    await insertLog(ctx, {
      id: '31000000-0000-4000-8000-000000000026',
      loggedAt: TRIGGER_AT,
      setIndex: 0,
      weightKg: 180,
    });
    const backfillId = '31000000-0000-4000-8000-000000000027';
    await insertLog(ctx, {
      id: backfillId,
      loggedAt: daysBefore(90),
      setIndex: 0,
      weightKg: 170,
    });

    await detect(ctx, backfillId);

    expect(await prRows(ctx)).toHaveLength(0);
  });

  it('treats the first completed actual set as a baseline when no baseline exists', async () => {
    const ctx = await makePrContext();
    const triggerId = '31000000-0000-4000-8000-000000000006';
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

  it.each([
    { name: 'failed', completed: true, failed: true },
    { name: 'incomplete', completed: false, failed: false },
  ])('does not trigger for a $name set', async ({ completed, failed }) => {
    const ctx = await makePrContext();
    await registerOneRm(ctx, { squat: 100 });
    const triggerId = '31000000-0000-4000-8000-000000000007';
    await insertLog(ctx, {
      id: triggerId,
      loggedAt: TRIGGER_AT,
      setIndex: 0,
      weightKg: 150,
      completed,
      failed,
    });

    await detect(ctx, triggerId);

    expect(await prRows(ctx)).toHaveLength(0);
  });

  it('ignores RPE, coach RPE, reps, and e1RM confidence for actual-weight PRs', async () => {
    const ctx = await makePrContext();
    await registerOneRm(ctx, { squat: 100 });
    const triggerId = '31000000-0000-4000-8000-000000000008';
    await insertLog(ctx, {
      id: triggerId,
      loggedAt: TRIGGER_AT,
      setIndex: 0,
      weightKg: 101,
      reps: 20,
      rpe: 0,
      coachRpe: 10,
      confidence: 'low',
    });

    await detect(ctx, triggerId);

    expect(await prRows(ctx)).toHaveLength(1);
  });

  it('does not let a higher extrapolated e1RM trigger below the actual-weight baseline', async () => {
    const ctx = await makePrContext();
    await insertLog(ctx, {
      id: '31000000-0000-4000-8000-000000000009',
      loggedAt: daysBefore(1),
      setIndex: 0,
      weightKg: 150,
      reps: 1,
    });
    const triggerId = '31000000-0000-4000-8000-000000000010';
    await insertLog(ctx, {
      id: triggerId,
      loggedAt: TRIGGER_AT,
      setIndex: 1,
      weightKg: 149,
      reps: 10,
      rpe: 10,
    });

    await detect(ctx, triggerId);

    expect(await prRows(ctx)).toHaveLength(0);
  });

  it('requires actual weight to be strictly greater than the baseline', async () => {
    const ctx = await makePrContext();
    await registerOneRm(ctx, { squat: 150 });
    const triggerId = '31000000-0000-4000-8000-000000000025';
    await insertLog(ctx, {
      id: triggerId,
      loggedAt: TRIGGER_AT,
      setIndex: 0,
      weightKg: 150,
    });

    await detect(ctx, triggerId);

    expect(await prRows(ctx)).toHaveLength(0);
  });

  it('excludes failed and incomplete history but counts imported (assumed) rows into the baseline', async () => {
    const ctx = await makePrContext();
    await insertLog(ctx, {
      id: '31000000-0000-4000-8000-000000000011',
      loggedAt: daysBefore(4),
      setIndex: 0,
      weightKg: 200,
      failed: true,
    });
    await insertLog(ctx, {
      id: '31000000-0000-4000-8000-000000000012',
      loggedAt: daysBefore(3),
      setIndex: 0,
      weightKg: 190,
      completed: false,
    });
    await insertLog(ctx, {
      id: '31000000-0000-4000-8000-000000000013',
      loggedAt: daysBefore(2),
      setIndex: 0,
      weightKg: 180,
      assumed: true,
    });
    await insertLog(ctx, {
      id: '31000000-0000-4000-8000-000000000014',
      loggedAt: daysBefore(1),
      setIndex: 0,
      weightKg: 150,
    });
    const triggerId = '31000000-0000-4000-8000-000000000015';
    await insertLog(ctx, {
      id: triggerId,
      loggedAt: TRIGGER_AT,
      setIndex: 1,
      weightKg: 151,
    });

    await detect(ctx, triggerId);

    // failed(200) and incomplete(190) stay out; the imported assumed row (180)
    // raises the baseline (2026-07-09 decision ④: imported history must not
    // let a returning lifter farm fake PRs), so 151 is NOT a PR.
    expect(await prRows(ctx)).toHaveLength(0);
  });

  it('never fires for an assumed (imported) trigger row even above the baseline', async () => {
    const ctx = await makePrContext();
    await insertLog(ctx, {
      id: '31000000-0000-4000-8000-000000000031',
      loggedAt: daysBefore(2),
      setIndex: 0,
      weightKg: 150,
    });
    const triggerId = '31000000-0000-4000-8000-000000000032';
    await insertLog(ctx, {
      id: triggerId,
      loggedAt: TRIGGER_AT,
      setIndex: 1,
      weightKg: 260,
      assumed: true,
    });

    await detect(ctx, triggerId);

    expect(await prRows(ctx)).toHaveLength(0);
  });

  it('lets a real set beat the imported baseline and records it as previous best', async () => {
    const ctx = await makePrContext();
    await insertLog(ctx, {
      id: '31000000-0000-4000-8000-000000000021',
      loggedAt: daysBefore(2),
      setIndex: 0,
      weightKg: 180,
      assumed: true,
    });
    const triggerId = '31000000-0000-4000-8000-000000000022';
    await insertLog(ctx, {
      id: triggerId,
      loggedAt: TRIGGER_AT,
      setIndex: 1,
      weightKg: 182.5,
    });

    await detect(ctx, triggerId);

    const event = (await prRows(ctx))[0];
    expect(payload(event?.payload ?? {}).previous_best_weight_kg).toBe(180);
    expect(payload(event?.payload ?? {}).weight_kg).toBe(182.5);
  });

  it('uses the registration field for the resolved family', async () => {
    const ctx = await makePrContext();
    await registerOneRm(ctx, { squat: 210, bench: 120 });
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
    const triggerId = '31000000-0000-4000-8000-000000000016';
    await insertLog(ctx, {
      id: triggerId,
      exerciseId: BENCH_EXERCISE_ID,
      loggedAt: TRIGGER_AT,
      setIndex: 0,
      weightKg: 122.5,
    });

    await detect(ctx, triggerId);

    expect(payload((await prRows(ctx))[0]?.payload ?? {})).toMatchObject({
      family: 'bench',
      previous_best_weight_kg: 120,
    });
  });

  it('does not trigger when the competition family cannot be resolved', async () => {
    const ctx = await makePrContext();
    await registerOneRm(ctx, { squat: 100 });
    await ctx.db
      .updateTable('exercises')
      .set({ is_competition_lift: false })
      .where('id', '=', ids.exercise)
      .execute();
    const triggerId = '31000000-0000-4000-8000-000000000017';
    await insertLog(ctx, {
      id: triggerId,
      loggedAt: TRIGGER_AT,
      setIndex: 0,
      weightKg: 150,
    });

    await detect(ctx, triggerId);

    expect(await prRows(ctx)).toHaveLength(0);
  });

  it('is idempotent when the same set-log hook is replayed', async () => {
    const ctx = await makePrContext();
    await registerOneRm(ctx, { squat: 100 });
    const triggerId = '31000000-0000-4000-8000-000000000018';
    await insertLog(ctx, {
      id: triggerId,
      loggedAt: TRIGGER_AT,
      setIndex: 0,
      weightKg: 102.5,
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

  it('updates one open congrats row with the higher actual weight and refreshes expiry', async () => {
    const ctx = await makePrContext();
    await registerOneRm(ctx, { squat: 100 });
    const firstPrId = '31000000-0000-4000-8000-000000000019';
    await insertLog(ctx, {
      id: firstPrId,
      loggedAt: daysBefore(1),
      setIndex: 0,
      weightKg: 105,
    });
    const higherPrId = '31000000-0000-4000-8000-000000000020';
    await insertLog(ctx, {
      id: higherPrId,
      loggedAt: TRIGGER_AT,
      setIndex: 1,
      weightKg: 110,
    });

    await detect(ctx, firstPrId, new Date('2026-07-10T01:00:00.000Z'));
    const refreshedAt = new Date('2026-07-10T02:00:00.000Z');
    await detect(ctx, higherPrId, refreshedAt);

    const signals = await ctx.db.selectFrom('student_signals').selectAll().execute();
    expect(signals).toHaveLength(1);
    expect(payload(signals[0]?.payload ?? {})).toMatchObject({
      set_log_id: higherPrId,
      metric: 'actual_weight',
      weight_kg: 110,
      previous_best_weight_kg: 105,
    });
    expect(signals[0]?.reason).toBe('深蹲实测重量新高 110.0kg（此前最好 105.0kg）');
    expect(signals[0]?.opened_at).toEqual(refreshedAt);
    expect(signals[0]?.expires_at).toEqual(
      new Date(refreshedAt.getTime() + SIGNAL_POLICY.signalExpiryDays * DAY_MS),
    );
  });

  it('can compare and retain a deployment-era open signal with the legacy payload', async () => {
    const ctx = await makePrContext();
    await registerOneRm(ctx, { squat: 100 });
    const legacyOpenedAt = daysBefore(2);
    await ctx.db
      .insertInto('student_signals')
      .values({
        student_id: ids.trainee,
        coach_id: ids.coach,
        signal_type: 'pr_congrats',
        severity: 'green',
        status: 'open',
        reason: 'legacy e1RM reason',
        payload: JSON.stringify({
          set_log_id: '31000000-0000-4000-8000-000000000021',
          exercise_id: ids.exercise,
          family: 'squat',
          e1rm: 120,
          previous_best: 110,
          logged_date: '2026-07-08',
        }),
        opened_at: legacyOpenedAt,
        expires_at: new Date(legacyOpenedAt.getTime() + SIGNAL_POLICY.signalExpiryDays * DAY_MS),
        updated_at: legacyOpenedAt,
      })
      .execute();
    const triggerId = '31000000-0000-4000-8000-000000000022';
    await insertLog(ctx, {
      id: triggerId,
      loggedAt: TRIGGER_AT,
      setIndex: 0,
      weightKg: 111,
    });
    const refreshedAt = new Date('2026-07-10T03:00:00.000Z');

    await detect(ctx, triggerId, refreshedAt);

    expect(await prRows(ctx)).toHaveLength(1);
    const signal = await ctx.db.selectFrom('student_signals').selectAll().executeTakeFirstOrThrow();
    expect(signal.reason).toBe('legacy e1RM reason');
    expect(payload(signal.payload)).toMatchObject({ e1rm: 120, previous_best: 110 });
    expect(signal.opened_at).toEqual(refreshedAt);
  });

  it('writes only the fact event when the student has no attributable coach', async () => {
    const ctx = await makePrContext();
    await registerOneRm(ctx, { studentId: ids.selfTrainStudent, squat: 100 });
    const triggerId = '31000000-0000-4000-8000-000000000023';
    await insertLog(ctx, {
      id: triggerId,
      studentId: ids.selfTrainStudent,
      loggedAt: TRIGGER_AT,
      setIndex: 0,
      weightKg: 105,
    });

    await detect(ctx, triggerId, TRIGGER_AT, ids.selfTrainStudent);

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
    await registerOneRm(ctx, { squat: 100 });
    const plan = await createPublishedPlan(ctx, ids.otherCoach);
    const triggerId = '31000000-0000-4000-8000-000000000024';
    await insertLog(ctx, {
      id: triggerId,
      planExerciseId: plan.planExerciseId,
      loggedAt: TRIGGER_AT,
      setIndex: 0,
      weightKg: 105,
    });
    const openedAt = new Date('2026-07-10T00:01:00.000Z');

    await recordSetLogActivity(ctx.db, ids.trainee, triggerId, openedAt, {
      enabled: true,
      logger: pino({ level: 'silent' }),
    });

    const event = await ctx.db
      .selectFrom('student_events')
      .selectAll()
      .where('event_type', '=', 'pr_e1rm')
      .executeTakeFirstOrThrow();
    const signal = await ctx.db.selectFrom('student_signals').selectAll().executeTakeFirstOrThrow();
    expect(event.coach_id).toBe(ids.otherCoach);
    expect(signal.coach_id).toBe(ids.otherCoach);
    expect(signal.opened_at).toEqual(openedAt);
    const outbox = await ctx.db
      .selectFrom('notification_outbox')
      .selectAll()
      .where('event_type', '=', 'pr_congrats')
      .executeTakeFirstOrThrow();
    expect(outbox).toMatchObject({ aggregate_id: signal.id, recipient_id: ids.otherCoach });
    expect(payload(outbox.payload as Record<string, unknown> | string)).toEqual({
      student_name: 'Trainee One',
      lift_name: '深蹲',
      increase_kg: 5,
      student_id: ids.trainee,
    });
  });
});
