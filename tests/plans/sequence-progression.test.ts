import { request } from '../helpers/inMemoryRequest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';

import { runDailySettlement, runSessionSweep } from '../../src/jobs/activity-settlement';
import { runDailyDigest } from '../../src/jobs/daily-digest';
import type { TestContext } from '../helpers/studentActions';
import { auth, createPublishedPlan, ids, makeContext } from '../helpers/studentActions';

async function addPlanDay(
  ctx: TestContext,
  planId: string,
  options: { dayOfWeek: number; weekNumber?: number; withSet?: boolean },
) {
  const day = await ctx.db
    .insertInto('plan_days')
    .values({
      plan_id: planId,
      day_of_week: options.dayOfWeek,
      week_number: options.weekNumber ?? 1,
      sort_order: 0,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const exercise = await ctx.db
    .insertInto('plan_exercises')
    .values({
      plan_day_id: day.id,
      exercise_id: ids.exercise,
      is_main_lift: true,
      sort_order: 0,
      notes: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  if (options.withSet !== false) {
    await ctx.db
      .insertInto('plan_sets')
      .values({
        plan_exercise_id: exercise.id,
        set_number: 1,
        target_reps: 5,
        target_reps_max: null,
        intensity_mode: 'weight',
        target_value: '100.00',
        set_type: 'working',
        rest_seconds: null,
      })
      .execute();
  }
  return { dayId: day.id, planExerciseId: exercise.id };
}

function coachedLog(planExerciseId: string, setIndex: number, overrides = {}) {
  return {
    plan_exercise_id: planExerciseId,
    set_index: setIndex,
    weight_kg: '100.00',
    reps: 5,
    completed: true,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

// Settlement is student-explicit (David 2026-08-08, revising 拍板 1's auto
// half): logging every prescribed set never writes a completion — only the
// explicit POST /plans/days/:dayId/complete settles a day.
describe('sequence progression settlement', () => {
  it.each(['completed', 'partial'] as const)(
    'edits a set after a 3-day undo without duplicating a %s session, events or coach pushes',
    async (sessionStatus) => {
      const originalTime = new Date('2026-11-01T12:00:00Z');
      const editTime = new Date('2026-11-04T12:00:00Z');
      // Issue a token valid at edit time; JWT iat does not impose a not-before gate.
      vi.useFakeTimers({ toFake: ['Date'], now: editTime });
      const logger = pino({ level: 'silent' });
      const ctx = await makeContext(logger, { config: { PUSH_ENABLED: true } });
      vi.setSystemTime(originalTime);
      const plan = await createPublishedPlan(ctx);
      await ctx.db
        .updateTable('plans')
        .set({ start_date: '2026-11-01', end_date: '2026-11-28' })
        .where('id', '=', plan.planId)
        .execute();
      await ctx.db
        .insertInto('student_onboarding_profiles')
        .values({ user_id: ids.trainee, squat_1rm_kg: '90.00' })
        .execute();
      if (sessionStatus === 'partial') {
        await ctx.db
          .insertInto('plan_sets')
          .values({
            plan_exercise_id: plan.planExerciseId,
            set_number: 2,
            target_reps: 5,
            intensity_mode: 'weight',
            target_value: '100.00',
            set_type: 'working',
          })
          .execute();
      }

      const logged = await request(ctx.app)
        .post('/sets/log')
        .set(auth(ctx.traineeToken))
        .send(coachedLog(plan.planExerciseId, 0, { reps: 8, logged_date: '2026-11-01' }));
      expect(logged.status).toBe(201);
      const completed = await request(ctx.app)
        .post(`/plans/days/${plan.dayId}/complete`)
        .set(auth(ctx.traineeToken));
      expect(completed.status).toBe(200);
      expect(completed.body.completed_at).toBe(originalTime.toISOString());

      const nextMorning = new Date('2026-11-02T12:00:00Z');
      await runSessionSweep(ctx.db, nextMorning);
      await runDailyDigest(ctx.db, '2026-11-01', nextMorning, logger);
      const settle = async () => {
        await runSessionSweep(ctx.db, editTime);
        expect(await runDailySettlement(ctx.db, '2026-11-03', editTime, logger, true)).toEqual([]);
        await runDailyDigest(ctx.db, '2026-11-03', editTime, logger);
      };
      vi.setSystemTime(editTime);
      await settle();
      const events = await ctx.db.selectFrom('student_events').selectAll().orderBy('id').execute();
      expect(events.map((event) => event.dedup_key).sort()).toEqual(
        [
          `session_${sessionStatus}:${ids.trainee}:2026-11-01`,
          `pr:${ids.trainee}:squat:${String(logged.body.id)}`,
        ].sort(),
      );
      const signals = await ctx.db
        .selectFrom('student_signals')
        .selectAll()
        .orderBy('id')
        .execute();
      expect(signals).toHaveLength(1);
      const outbox = await ctx.db
        .selectFrom('notification_outbox')
        .selectAll()
        .orderBy('id')
        .execute();
      expect(outbox.map((row) => row.event_type).sort()).toEqual([
        'coach_daily_digest',
        'pr_congrats',
      ]);
      const session = await ctx.db
        .selectFrom('training_sessions')
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(session).toMatchObject({ status: sessionStatus, archived_sets_logged: 1 });

      const undone = await request(ctx.app)
        .delete(`/plans/days/${plan.dayId}/complete`)
        .set(auth(ctx.traineeToken));
      expect(undone.status).toBe(204);
      const edited = await request(ctx.app)
        .post('/sets/log')
        .set(auth(ctx.traineeToken))
        .send(coachedLog(plan.planExerciseId, 0, { reps: 5, logged_date: '2026-11-01' }));
      expect(edited.status).toBe(201);
      expect(edited.body.id).toBe(logged.body.id);
      const recompleted = await request(ctx.app)
        .post(`/plans/days/${plan.dayId}/complete`)
        .set(auth(ctx.traineeToken));
      expect(recompleted.status).toBe(200);
      expect(recompleted.body.completed_at).toBe(editTime.toISOString());
      const logs = await request(ctx.app)
        .get(`/students/${ids.trainee}/sets?from=2026-11-01&to=2026-11-04`)
        .set(auth(ctx.traineeToken));
      expect(logs.status).toBe(200);
      expect(logs.body.logs).toEqual([
        expect.objectContaining({ id: logged.body.id, reps: 5, logged_date: '2026-11-01' }),
      ]);
      await settle();

      expect(await ctx.db.selectFrom('student_events').selectAll().orderBy('id').execute()).toEqual(
        events,
      );
      expect(
        await ctx.db.selectFrom('student_signals').selectAll().orderBy('id').execute(),
      ).toEqual(signals);
      expect(
        await ctx.db.selectFrom('notification_outbox').selectAll().orderBy('id').execute(),
      ).toEqual(outbox);
      expect(await ctx.db.selectFrom('training_sessions').selectAll().execute()).toEqual([
        { ...session, updated_at: editTime },
      ]);
      expect(await ctx.db.selectFrom('plan_day_completions').selectAll().execute()).toHaveLength(1);
    },
  );

  it('does not auto-complete a fully logged prescribed day', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);

    const response = await request(ctx.app)
      .post('/sets/log')
      .set(auth(ctx.traineeToken))
      .send(coachedLog(plan.planExerciseId, 0, { completed: false, failed: true }));

    expect(response.status).toBe(201);
    expect(await ctx.db.selectFrom('plan_day_completions').selectAll().execute()).toHaveLength(0);
  });

  it('settles a fully logged day only via the explicit complete call', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);

    await request(ctx.app)
      .post('/sets/log')
      .set(auth(ctx.traineeToken))
      .send(coachedLog(plan.planExerciseId, 0));
    expect(await ctx.db.selectFrom('plan_day_completions').selectAll().execute()).toHaveLength(0);

    const completed = await request(ctx.app)
      .post(`/plans/days/${plan.dayId}/complete`)
      .set(auth(ctx.traineeToken))
      .send({});
    expect(completed.status).toBeLessThan(300);
    const completion = await ctx.db
      .selectFrom('plan_day_completions')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(completion).toMatchObject({
      plan_day_id: plan.dayId,
      student_id: ids.trainee,
      source: 'manual',
    });
  });

  it('undoes a legacy auto completion and resettles it as manual', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    // Row written while the retired auto path was live.
    await ctx.db
      .insertInto('plan_day_completions')
      .values({ plan_day_id: plan.dayId, student_id: ids.trainee, source: 'auto' })
      .execute();

    const deleted = await request(ctx.app)
      .delete(`/plans/days/${plan.dayId}/complete`)
      .set(auth(ctx.traineeToken));
    expect(deleted.status).toBe(204);

    await request(ctx.app)
      .post(`/plans/days/${plan.dayId}/complete`)
      .set(auth(ctx.traineeToken))
      .send({});
    const completion = await ctx.db
      .selectFrom('plan_day_completions')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(completion.source).toBe('manual');
  });

  it('lets a withdrawn day be settled again explicitly', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);

    await request(ctx.app)
      .post('/sets/log')
      .set(auth(ctx.traineeToken))
      .send(coachedLog(plan.planExerciseId, 0));
    await request(ctx.app)
      .post(`/plans/days/${plan.dayId}/complete`)
      .set(auth(ctx.traineeToken))
      .send({});
    const deleted = await request(ctx.app)
      .delete(`/plans/days/${plan.dayId}/complete`)
      .set(auth(ctx.traineeToken));
    expect(deleted.status).toBe(204);
    expect(await ctx.db.selectFrom('plan_day_completions').selectAll().execute()).toHaveLength(0);

    await request(ctx.app)
      .post(`/plans/days/${plan.dayId}/complete`)
      .set(auth(ctx.traineeToken))
      .send({});
    const completion = await ctx.db
      .selectFrom('plan_day_completions')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(completion.source).toBe('manual');
  });
});

describe('sequence progression manual completion', () => {
  it('allows zero prescribed sets and returns the same completion idempotently', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await ctx.db
      .deleteFrom('plan_sets')
      .where('plan_exercise_id', '=', plan.planExerciseId)
      .execute();

    const first = await request(ctx.app)
      .post(`/plans/days/${plan.dayId}/complete`)
      .set(auth(ctx.traineeToken));
    const second = await request(ctx.app)
      .post(`/plans/days/${plan.dayId}/complete`)
      .set(auth(ctx.traineeToken));

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      plan_day_id: plan.dayId,
      student_id: ids.trainee,
      source: 'manual',
    });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(await ctx.db.selectFrom('plan_day_completions').selectAll().execute()).toHaveLength(1);
  });

  it('rejects another student and a non-published plan with the domain envelopes', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);

    const otherStudent = await request(ctx.app)
      .post(`/plans/days/${plan.dayId}/complete`)
      .set(auth(ctx.otherStudentToken));
    expect(otherStudent.status).toBe(403);
    expect(otherStudent.body).toEqual({ error: 'NOT_PLAN_STUDENT' });

    await ctx.db
      .updateTable('plans')
      .set({ status: 'draft' })
      .where('id', '=', plan.planId)
      .execute();
    const inactive = await request(ctx.app)
      .post(`/plans/days/${plan.dayId}/complete`)
      .set(auth(ctx.traineeToken));
    expect(inactive.status).toBe(409);
    expect(inactive.body).toEqual({ error: 'PLAN_NOT_ACTIVE' });
  });
});

describe('sequence progression completion undo', () => {
  it.each([
    ['Asia/Shanghai', '2026-10-22T12:00:00Z', '2026-10-29T11:00:00Z', 204],
    ['Europe/London', '2026-10-22T12:00:00Z', '2026-10-29T11:00:00Z', 204],
    ['Europe/London', '2026-10-22T12:00:00Z', '2026-10-29T12:00:00Z', 409],
    ['America/New_York', '2026-10-22T12:00:00Z', '2026-10-29T12:01:00Z', 409],
  ])('uses rolling elapsed time in %s at %s → %s', async (timezone, completedAt, now, status) => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(now) });
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await ctx.db.updateTable('users').set({ timezone }).where('id', '=', ids.trainee).execute();
    await ctx.db
      .insertInto('plan_day_completions')
      .values({
        plan_day_id: plan.dayId,
        student_id: ids.trainee,
        source: 'manual',
        completed_at: new Date(completedAt),
      })
      .execute();

    const response = await request(ctx.app)
      .delete(`/plans/days/${plan.dayId}/complete`)
      .set(auth(ctx.traineeToken));
    expect(response.status).toBe(status);
    if (status === 409) expect(response.body).toEqual({ error: 'UNDO_WINDOW_PASSED' });
  });

  it('only removes the latest completion in the target plan', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    const secondDay = await addPlanDay(ctx, plan.planId, { dayOfWeek: 2, withSet: false });
    await ctx.db
      .insertInto('plan_day_completions')
      .values([
        {
          plan_day_id: plan.dayId,
          student_id: ids.trainee,
          source: 'manual',
          completed_at: new Date(Date.now() - 60_000),
        },
        {
          plan_day_id: secondDay.dayId,
          student_id: ids.trainee,
          source: 'manual',
          completed_at: new Date(),
        },
      ])
      .execute();

    const older = await request(ctx.app)
      .delete(`/plans/days/${plan.dayId}/complete`)
      .set(auth(ctx.traineeToken));
    expect(older.status).toBe(409);
    expect(older.body).toEqual({ error: 'NOT_LATEST_COMPLETION' });

    const latest = await request(ctx.app)
      .delete(`/plans/days/${secondDay.dayId}/complete`)
      .set(auth(ctx.traineeToken));
    expect(latest.status).toBe(204);
  });

  it('returns NO_COMPLETION_TO_UNDO for an unfinished day', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);

    const response = await request(ctx.app)
      .delete(`/plans/days/${plan.dayId}/complete`)
      .set(auth(ctx.traineeToken));
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'NO_COMPLETION_TO_UNDO' });
  });

  it.each([
    ['Asia/Shanghai', '2026-07-12T19:59:59Z', '2026-07-12T20:00:00Z'],
    ['Europe/London', '2026-01-13T03:59:59Z', '2026-01-13T04:00:00Z'],
    ['Europe/London', '2026-07-13T02:59:59Z', '2026-07-13T03:00:00Z'],
    ['America/New_York', '2026-07-13T07:59:59Z', '2026-07-13T08:00:00Z'],
  ])('allows undo across the %s 04:00 gym-day boundary', async (timezone, before, at) => {
    const beforeCutoff = new Date(before);

    const allowedCtx = await makeContext();
    const allowedPlan = await createPublishedPlan(allowedCtx);
    await allowedCtx.db
      .updateTable('users')
      .set({ timezone })
      .where('id', '=', ids.trainee)
      .execute();
    await allowedCtx.db
      .insertInto('plan_day_completions')
      .values({
        plan_day_id: allowedPlan.dayId,
        student_id: ids.trainee,
        source: 'manual',
        completed_at: beforeCutoff,
      })
      .execute();
    vi.useFakeTimers({ toFake: ['Date'], now: beforeCutoff });
    const allowed = await request(allowedCtx.app)
      .delete(`/plans/days/${allowedPlan.dayId}/complete`)
      .set(auth(allowedCtx.traineeToken));
    expect(allowed.status).toBe(204);

    vi.useRealTimers();
    const crossedCtx = await makeContext();
    const crossedPlan = await createPublishedPlan(crossedCtx);
    await crossedCtx.db
      .updateTable('users')
      .set({ timezone })
      .where('id', '=', ids.trainee)
      .execute();
    await crossedCtx.db
      .insertInto('plan_day_completions')
      .values({
        plan_day_id: crossedPlan.dayId,
        student_id: ids.trainee,
        source: 'manual',
        completed_at: beforeCutoff,
      })
      .execute();
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(at) });
    const crossed = await request(crossedCtx.app)
      .delete(`/plans/days/${crossedPlan.dayId}/complete`)
      .set(auth(crossedCtx.traineeToken));
    expect(crossed.status).toBe(204);
  });
});

describe('sequence progression backfill and serialization', () => {
  it.each([
    ['Asia/Shanghai', '2026-07-10T16:30:00Z', 1],
    ['Europe/London', '2026-07-10T23:30:00Z', 1],
    ['America/New_York', '2026-07-11T00:30:00Z', 0],
  ])(
    'uses the %s requester calendar date for imported-history windows',
    async (timezone, instant, expectedCreated) => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date(instant) });
      const ctx = await makeContext();
      const plan = await createPublishedPlan(ctx);
      await ctx.db.updateTable('users').set({ timezone }).where('id', '=', ids.coach).execute();
      await ctx.db
        .updateTable('plans')
        .set({ start_date: '2026-07-10', end_date: '2026-07-31' })
        .where('id', '=', plan.planId)
        .execute();

      const response = await request(ctx.app)
        .post(`/plans/${plan.planId}/imported-history`)
        .set(auth(ctx.coachToken))
        .send({ confirm: true });

      expect(response.status).toBe(200);
      expect(response.body.created_set_logs).toBe(expectedCreated);
    },
  );

  it('backfills old assumed days once and leaves the first unimported day incomplete', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-08-07T12:00:00.000Z') });
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await ctx.db
      .updateTable('plans')
      .set({ start_date: '2026-08-01', end_date: '2026-08-31' })
      .where('id', '=', plan.planId)
      .execute();
    const cursorDay = await addPlanDay(ctx, plan.planId, { dayOfWeek: 7 });

    const first = await request(ctx.app)
      .post(`/plans/${plan.planId}/imported-history`)
      .set(auth(ctx.coachToken))
      .send({ confirm: true });
    const second = await request(ctx.app)
      .post(`/plans/${plan.planId}/imported-history`)
      .set(auth(ctx.coachToken))
      .send({ confirm: true });
    const completions = await ctx.db.selectFrom('plan_day_completions').selectAll().execute();
    const detail = await request(ctx.app).get(`/plans/${plan.planId}`).set(auth(ctx.traineeToken));

    expect(first.status).toBe(200);
    expect(first.body.created_set_logs).toBe(1);
    expect(second.status).toBe(200);
    expect(second.body.created_set_logs).toBe(0);
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      plan_day_id: plan.dayId,
      source: 'backfill',
      completed_at: new Date('2026-08-01T00:00:00.000Z'),
    });
    expect(detail.body.days).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: plan.dayId,
          completed_at: '2026-08-01T00:00:00.000Z',
          completion_source: 'backfill',
        }),
        expect.objectContaining({
          id: cursorDay.dayId,
          completed_at: null,
          completion_source: null,
        }),
      ]),
    );
  });

  it('writes published_at on publish and paused-to-published transitions', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await ctx.db
      .updateTable('plans')
      .set({ status: 'draft', published_at: null })
      .where('id', '=', plan.planId)
      .execute();

    const published = await request(ctx.app)
      .post(`/plans/${plan.planId}/publish`)
      .set(auth(ctx.coachToken));
    expect(published.status).toBe(200);
    expect(published.body.published_at).toEqual(expect.any(String));

    await request(ctx.app)
      .patch(`/plans/${plan.planId}`)
      .set(auth(ctx.coachToken))
      .send({ status: 'paused' });
    await ctx.db
      .updateTable('plans')
      .set({ published_at: new Date('2000-01-01T00:00:00.000Z') })
      .where('id', '=', plan.planId)
      .execute();
    const republished = await request(ctx.app)
      .patch(`/plans/${plan.planId}`)
      .set(auth(ctx.coachToken))
      .send({ status: 'published' });
    const list = await request(ctx.app)
      .get(`/students/${ids.trainee}/plans`)
      .set(auth(ctx.coachToken));

    expect(republished.status).toBe(200);
    expect(republished.body.published_at).not.toBe('2000-01-01T00:00:00.000Z');
    expect(list.body.plans[0]).toMatchObject({
      id: plan.planId,
      published_at: republished.body.published_at,
    });
  });
});

describe('out-of-order student settlement', () => {
  it('settles D4 before D2, keeps the earliest unfinished cursor, and only undoes the latest completion', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-13T12:00:00Z') });
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await ctx.db
      .updateTable('plan_days')
      .set({ day_of_week: 2 })
      .where('id', '=', plan.dayId)
      .execute();
    const d3 = await addPlanDay(ctx, plan.planId, { dayOfWeek: 3 });
    const d4 = await addPlanDay(ctx, plan.planId, { dayOfWeek: 4 });
    const expectCursor = async (dayId: string) => {
      const detail = await request(ctx.app)
        .get(`/plans/${plan.planId}`)
        .set(auth(ctx.traineeToken));
      expect(detail.status).toBe(200);
      const days = detail.body.days as {
        id: string;
        week_number: number;
        day_of_week: number;
        completed_at: string | null;
      }[];
      // Spec 035 defines the cursor as the earliest unfinished day in plan order.
      const unfinished = days
        .filter((day) => day.completed_at === null)
        .sort(
          (left, right) =>
            left.week_number - right.week_number || left.day_of_week - right.day_of_week,
        );
      expect(unfinished[0]?.id).toBe(dayId);
    };
    await expectCursor(plan.dayId);
    const d4Log = await request(ctx.app)
      .post('/sets/log')
      .set(auth(ctx.traineeToken))
      .send(coachedLog(d4.planExerciseId, 0));
    expect(d4Log.status).toBe(201);
    const d4Completed = await request(ctx.app)
      .post(`/plans/days/${d4.dayId}/complete`)
      .set(auth(ctx.traineeToken))
      .send({});
    expect(d4Completed.status).toBe(200);
    await expectCursor(plan.dayId);
    vi.setSystemTime(new Date('2026-10-13T12:01:00Z'));
    const d2Log = await request(ctx.app)
      .post('/sets/log')
      .set(auth(ctx.traineeToken))
      .send(coachedLog(plan.planExerciseId, 0));
    expect(d2Log.status).toBe(201);
    const d2Completed = await request(ctx.app)
      .post(`/plans/days/${plan.dayId}/complete`)
      .set(auth(ctx.traineeToken))
      .send({});
    expect(d2Completed.status).toBe(200);
    await expectCursor(d3.dayId);
    const refuseD4 = await request(ctx.app)
      .delete(`/plans/days/${d4.dayId}/complete`)
      .set(auth(ctx.traineeToken));
    expect(refuseD4.status).toBe(409);
    expect(refuseD4.body).toEqual({ error: 'NOT_LATEST_COMPLETION' });
    await expectCursor(d3.dayId);
    const undoD2 = await request(ctx.app)
      .delete(`/plans/days/${plan.dayId}/complete`)
      .set(auth(ctx.traineeToken));
    expect(undoD2.status).toBe(204);
    await expectCursor(plan.dayId);
  });
});
