import request from 'supertest';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { recordSetLogActivity, sweepTimedOutSessions } from '../src/handlers/activity-ledger';
import { normalizeDateOnly } from '../src/utils/date';
import {
  auth,
  createPublishedPlan,
  ids,
  makeContext,
  type TestContext,
} from './helpers/studentActions';

interface LogFixture {
  id: string;
  studentId?: string;
  planExerciseId?: string | null;
  loggedDate: string;
  loggedAt: Date;
  setIndex: number;
  completed?: boolean;
  failed?: boolean;
  adhoc?: boolean;
}

async function insertLog(ctx: TestContext, fixture: LogFixture): Promise<void> {
  await ctx.db
    .insertInto('set_logs')
    .values({
      id: fixture.id,
      student_id: fixture.studentId ?? ids.trainee,
      plan_exercise_id: fixture.planExerciseId ?? null,
      exercise_id: ids.exercise,
      logged_date: fixture.loggedDate,
      logged_at: fixture.loggedAt,
      set_index: fixture.setIndex,
      weight_kg: '100.00',
      reps: 5,
      rpe: '8.0',
      completed: fixture.completed ?? true,
      failed: fixture.failed ?? false,
      assumed: false,
      adhoc: fixture.adhoc ?? fixture.planExerciseId == null,
    })
    .execute();
}

async function addPlanSet(
  ctx: TestContext,
  planExerciseId: string,
  setNumber: number,
): Promise<void> {
  await ctx.db
    .insertInto('plan_sets')
    .values({
      plan_exercise_id: planExerciseId,
      set_number: setNumber,
      target_reps: 5,
      target_reps_max: null,
      intensity_mode: 'weight',
      target_value: '100.00',
      set_type: 'working',
      rest_seconds: null,
    })
    .execute();
}

async function addSecondPlanSet(ctx: TestContext, planExerciseId: string): Promise<void> {
  await addPlanSet(ctx, planExerciseId, 2);
}

function parsedPayload(value: Record<string, unknown> | string): Record<string, unknown> {
  return typeof value === 'string' ? (JSON.parse(value) as Record<string, unknown>) : value;
}

describe('activity ledger session state machine', () => {
  it('replays a completed set-log upsert without duplicating its fact event', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    const setLogId = '30000000-0000-4000-8000-000000000001';
    await insertLog(ctx, {
      id: setLogId,
      planExerciseId: plan.planExerciseId,
      loggedDate: '2026-07-10',
      loggedAt: new Date('2026-07-09T21:00:00Z'),
      setIndex: 0,
    });

    const completedAt = new Date('2026-07-09T21:01:00Z');
    await recordSetLogActivity(ctx.db, ids.trainee, setLogId, completedAt);
    await recordSetLogActivity(ctx.db, ids.trainee, setLogId, completedAt);

    const session = await ctx.db
      .selectFrom('training_sessions')
      .selectAll()
      .executeTakeFirstOrThrow();
    const events = await ctx.db.selectFrom('student_events').selectAll().execute();
    const event = events[0];
    if (!event) throw new Error('expected a completed session event');
    expect(session.status).toBe('completed');
    expect(session.completed_at).toEqual(completedAt);
    expect(events).toHaveLength(1);
    expect(event.dedup_key).toBe(`session_completed:${ids.trainee}:2026-07-10`);
    // The trainee is bonded to two coaches; attribution must follow the coach
    // who owns the touched plan, not an arbitrary accepted bond.
    expect(event.coach_id).toBe(ids.coach);
    expect(parsedPayload(event.payload)).toEqual({
      session_id: session.id,
      plan_day_ids: [plan.dayId],
      duration_seconds: 0,
      sets_logged: 1,
    });
  });

  it('separates gym days exactly at the Shanghai 04:00 boundary', async () => {
    const ctx = await makeContext();
    const beforeId = '30000000-0000-4000-8000-000000000002';
    const boundaryId = '30000000-0000-4000-8000-000000000003';
    await insertLog(ctx, {
      id: beforeId,
      studentId: ids.selfTrainStudent,
      loggedDate: '2026-07-09',
      loggedAt: new Date('2026-07-09T19:59:59Z'),
      setIndex: 0,
      adhoc: true,
    });
    await insertLog(ctx, {
      id: boundaryId,
      studentId: ids.selfTrainStudent,
      loggedDate: '2026-07-10',
      loggedAt: new Date('2026-07-09T20:00:00Z'),
      setIndex: 0,
      adhoc: true,
    });

    await recordSetLogActivity(ctx.db, ids.selfTrainStudent, beforeId);
    await recordSetLogActivity(ctx.db, ids.selfTrainStudent, boundaryId);

    const sessions = await ctx.db
      .selectFrom('training_sessions')
      .selectAll()
      .orderBy('session_date')
      .execute();
    expect(sessions.map((session) => normalizeDateOnly(session.session_date))).toEqual([
      '2026-07-09',
      '2026-07-10',
    ]);
    expect(sessions.map((session) => session.started_at.toISOString())).toEqual([
      '2026-07-09T19:59:59.000Z',
      '2026-07-09T20:00:00.000Z',
    ]);
  });

  it('completes a coached and adhoc mixed day from planned work only', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    const adhocId = '30000000-0000-4000-8000-000000000004';
    const plannedId = '30000000-0000-4000-8000-000000000005';
    await insertLog(ctx, {
      id: adhocId,
      loggedDate: '2026-07-10',
      loggedAt: new Date('2026-07-09T21:00:00Z'),
      setIndex: 9,
      adhoc: true,
    });
    await insertLog(ctx, {
      id: plannedId,
      planExerciseId: plan.planExerciseId,
      loggedDate: '2026-07-10',
      loggedAt: new Date('2026-07-09T21:05:00Z'),
      setIndex: 0,
    });

    await recordSetLogActivity(ctx.db, ids.trainee, plannedId);

    const session = await ctx.db
      .selectFrom('training_sessions')
      .selectAll()
      .executeTakeFirstOrThrow();
    const event = await ctx.db
      .selectFrom('student_events')
      .select('payload')
      .executeTakeFirstOrThrow();
    expect(session.status).toBe('completed');
    expect(session.plan_day_ids).toEqual([plan.dayId]);
    expect(parsedPayload(event.payload).sets_logged).toBe(2);
  });

  it('counts submitted sets instead of matching 0-based set_index to set_number', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await addSecondPlanSet(ctx, plan.planExerciseId);
    const firstId = '30000000-0000-4000-8000-000000000006';
    const secondId = '30000000-0000-4000-8000-000000000007';
    await insertLog(ctx, {
      id: firstId,
      planExerciseId: plan.planExerciseId,
      loggedDate: '2026-07-10',
      loggedAt: new Date('2026-07-09T21:00:00Z'),
      setIndex: 0,
    });
    await insertLog(ctx, {
      id: secondId,
      planExerciseId: plan.planExerciseId,
      loggedDate: '2026-07-10',
      loggedAt: new Date('2026-07-09T21:05:00Z'),
      setIndex: 1,
      completed: false,
      failed: true,
    });

    await recordSetLogActivity(ctx.db, ids.trainee, secondId);

    const session = await ctx.db
      .selectFrom('training_sessions')
      .select('status')
      .executeTakeFirstOrThrow();
    expect(session.status).toBe('completed');
  });

  it('does not move session timing when an edit moves its log outside the gym-day window', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await addSecondPlanSet(ctx, plan.planExerciseId);
    const firstId = '30000000-0000-4000-8000-000000000013';
    const setLogId = '30000000-0000-4000-8000-000000000008';
    await insertLog(ctx, {
      id: firstId,
      planExerciseId: plan.planExerciseId,
      loggedDate: '2026-07-10',
      loggedAt: new Date('2026-07-09T21:00:00Z'),
      setIndex: 0,
    });
    await insertLog(ctx, {
      id: setLogId,
      planExerciseId: plan.planExerciseId,
      loggedDate: '2026-07-10',
      loggedAt: new Date('2026-07-09T21:05:00Z'),
      setIndex: 1,
    });
    await recordSetLogActivity(ctx.db, ids.trainee, setLogId);

    await ctx.db
      .updateTable('set_logs')
      .set({ logged_at: new Date('2026-07-10T21:00:00Z') })
      .where('id', '=', setLogId)
      .execute();
    await recordSetLogActivity(ctx.db, ids.trainee, setLogId);

    const session = await ctx.db
      .selectFrom('training_sessions')
      .select(['started_at', 'last_set_at'])
      .executeTakeFirstOrThrow();
    expect(session.started_at.toISOString()).toBe('2026-07-09T21:00:00.000Z');
    expect(session.last_set_at.toISOString()).toBe('2026-07-09T21:05:00.000Z');
  });

  it('keeps started_at anchored when an in-window edit refreshes logged_at', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await addSecondPlanSet(ctx, plan.planExerciseId);
    const firstId = '30000000-0000-4000-8000-000000000014';
    const secondId = '30000000-0000-4000-8000-000000000015';
    await insertLog(ctx, {
      id: firstId,
      planExerciseId: plan.planExerciseId,
      loggedDate: '2026-07-10',
      loggedAt: new Date('2026-07-09T21:00:00Z'),
      setIndex: 0,
    });
    await recordSetLogActivity(ctx.db, ids.trainee, firstId);
    await insertLog(ctx, {
      id: secondId,
      planExerciseId: plan.planExerciseId,
      loggedDate: '2026-07-10',
      loggedAt: new Date('2026-07-09T21:30:00Z'),
      setIndex: 1,
    });
    await recordSetLogActivity(ctx.db, ids.trainee, secondId);

    // Editing the FIRST set refreshes its logged_at to a later in-window time;
    // the session must keep its original start and extend its last submission.
    await ctx.db
      .updateTable('set_logs')
      .set({ logged_at: new Date('2026-07-09T22:00:00Z') })
      .where('id', '=', firstId)
      .execute();
    await recordSetLogActivity(ctx.db, ids.trainee, firstId);

    const session = await ctx.db
      .selectFrom('training_sessions')
      .select(['started_at', 'last_set_at'])
      .executeTakeFirstOrThrow();
    expect(session.started_at.toISOString()).toBe('2026-07-09T21:00:00.000Z');
    expect(session.last_set_at.toISOString()).toBe('2026-07-09T22:00:00.000Z');
  });

  it('reopens partial on a new set and can go directly to completed', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await addSecondPlanSet(ctx, plan.planExerciseId);
    const firstId = '30000000-0000-4000-8000-000000000009';
    const secondId = '30000000-0000-4000-8000-000000000010';
    await insertLog(ctx, {
      id: firstId,
      planExerciseId: plan.planExerciseId,
      loggedDate: '2026-07-10',
      loggedAt: new Date('2026-07-09T20:30:00Z'),
      setIndex: 0,
    });
    await recordSetLogActivity(ctx.db, ids.trainee, firstId);
    await sweepTimedOutSessions(ctx.db, new Date('2026-07-10T01:00:01Z'));

    await insertLog(ctx, {
      id: secondId,
      planExerciseId: plan.planExerciseId,
      loggedDate: '2026-07-10',
      loggedAt: new Date('2026-07-10T02:00:00Z'),
      setIndex: 1,
    });
    await recordSetLogActivity(ctx.db, ids.trainee, secondId, new Date('2026-07-10T02:00:01Z'));

    const session = await ctx.db
      .selectFrom('training_sessions')
      .select('status')
      .executeTakeFirstOrThrow();
    const events = await ctx.db
      .selectFrom('student_events')
      .select('event_type')
      .orderBy('event_type')
      .execute();
    expect(session.status).toBe('completed');
    expect(events.map((event) => event.event_type)).toEqual([
      'session_completed',
      'session_partial',
    ]);
  });

  it('keeps a re-archived partial closed when an already-counted set is replayed', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await addPlanSet(ctx, plan.planExerciseId, 2);
    await addPlanSet(ctx, plan.planExerciseId, 3);
    const firstId = '30000000-0000-4000-8000-000000000016';
    const secondId = '30000000-0000-4000-8000-000000000017';
    await insertLog(ctx, {
      id: firstId,
      planExerciseId: plan.planExerciseId,
      loggedDate: '2026-07-10',
      loggedAt: new Date('2026-07-09T20:30:00Z'),
      setIndex: 0,
    });
    await recordSetLogActivity(ctx.db, ids.trainee, firstId);
    // First archive snapshots 1 set.
    await sweepTimedOutSessions(ctx.db, new Date('2026-07-10T00:30:01Z'));

    // A genuinely new set reopens, then times out again: snapshot becomes 2.
    await insertLog(ctx, {
      id: secondId,
      planExerciseId: plan.planExerciseId,
      loggedDate: '2026-07-10',
      loggedAt: new Date('2026-07-10T01:00:00Z'),
      setIndex: 1,
    });
    await recordSetLogActivity(ctx.db, ids.trainee, secondId);
    await sweepTimedOutSessions(ctx.db, new Date('2026-07-10T05:00:01Z'));

    // Replaying/editing the second set must NOT reopen the archived session —
    // the live count (2) no longer exceeds the latest snapshot (2).
    await recordSetLogActivity(ctx.db, ids.trainee, secondId);

    const session = await ctx.db
      .selectFrom('training_sessions')
      .select(['status', 'archived_sets_logged'])
      .executeTakeFirstOrThrow();
    expect(session.status).toBe('partial');
    expect(session.archived_sets_logged).toBe(2);
  });

  it('sweeps planned and pure-adhoc timeouts to different terminal states idempotently', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await addSecondPlanSet(ctx, plan.planExerciseId);
    const plannedId = '30000000-0000-4000-8000-000000000011';
    const adhocId = '30000000-0000-4000-8000-000000000012';
    await insertLog(ctx, {
      id: plannedId,
      planExerciseId: plan.planExerciseId,
      loggedDate: '2026-07-10',
      loggedAt: new Date('2026-07-09T21:00:00Z'),
      setIndex: 0,
    });
    await insertLog(ctx, {
      id: adhocId,
      studentId: ids.selfTrainStudent,
      loggedDate: '2026-07-10',
      loggedAt: new Date('2026-07-09T21:00:00Z'),
      setIndex: 0,
      adhoc: true,
    });
    await recordSetLogActivity(ctx.db, ids.trainee, plannedId);
    await recordSetLogActivity(ctx.db, ids.selfTrainStudent, adhocId);

    await sweepTimedOutSessions(ctx.db, new Date('2026-07-10T01:00:00Z'));
    const atThreshold = await ctx.db.selectFrom('training_sessions').select('status').execute();
    expect(atThreshold.map((session) => session.status)).toEqual(['in_progress', 'in_progress']);

    const now = new Date('2026-07-10T01:00:01Z');
    await sweepTimedOutSessions(ctx.db, now);
    await sweepTimedOutSessions(ctx.db, now);

    const sessions = await ctx.db
      .selectFrom('training_sessions')
      .select(['student_id', 'status', 'completed_at'])
      .orderBy('student_id')
      .execute();
    const events = await ctx.db.selectFrom('student_events').selectAll().execute();
    const selfTrainEvent = events.find((event) => event.student_id === ids.selfTrainStudent);
    if (!selfTrainEvent) throw new Error('expected a self-train session event');
    expect(sessions).toEqual([
      expect.objectContaining({
        student_id: ids.trainee,
        status: 'partial',
        completed_at: null,
      }),
      expect.objectContaining({
        student_id: ids.selfTrainStudent,
        status: 'completed',
        completed_at: now,
      }),
    ]);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.event_type).sort()).toEqual([
      'session_completed',
      'session_partial',
    ]);
    expect(selfTrainEvent.coach_id).toBeNull();
  });

  it('deletes a timed-out explicit session with zero sets and emits no event', async () => {
    const ctx = await makeContext();
    await ctx.db
      .insertInto('training_sessions')
      .values({
        student_id: ids.trainee,
        session_date: '2026-07-10',
        status: 'in_progress',
        started_at: new Date('2026-07-09T20:00:00Z'),
        last_set_at: new Date('2026-07-09T20:00:00Z'),
        plan_day_ids: [],
      })
      .execute();

    const now = new Date('2026-07-10T00:00:01Z');
    await sweepTimedOutSessions(ctx.db, now);
    await sweepTimedOutSessions(ctx.db, now);

    const sessions = await ctx.db.selectFrom('training_sessions').select('id').execute();
    const events = await ctx.db.selectFrom('student_events').select('id').execute();
    expect(sessions).toEqual([]);
    expect(events).toEqual([]);
  });

  it('does not archive a session whose newest set has not been through the hook yet', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await addSecondPlanSet(ctx, plan.planExerciseId);
    const firstId = '30000000-0000-4000-8000-000000000018';
    const secondId = '30000000-0000-4000-8000-000000000019';
    await insertLog(ctx, {
      id: firstId,
      planExerciseId: plan.planExerciseId,
      loggedDate: '2026-07-10',
      loggedAt: new Date('2026-07-09T20:30:00Z'),
      setIndex: 0,
    });
    await recordSetLogActivity(ctx.db, ids.trainee, firstId);

    // A second set exists in set_logs but its route hook never ran (crash
    // between commit and hook). The sweep must reconcile from live logs: the
    // fresh set extends the clock, so no archive happens...
    await insertLog(ctx, {
      id: secondId,
      planExerciseId: plan.planExerciseId,
      loggedDate: '2026-07-10',
      loggedAt: new Date('2026-07-10T00:29:00Z'),
      setIndex: 1,
    });
    await sweepTimedOutSessions(ctx.db, new Date('2026-07-10T00:30:01Z'));
    const midway = await ctx.db
      .selectFrom('training_sessions')
      .select('status')
      .executeTakeFirstOrThrow();
    expect(midway.status).toBe('in_progress');

    // ...and once the day truly times out, the reconcile counts the unhooked
    // set toward completion instead of swallowing it into a partial snapshot.
    await sweepTimedOutSessions(ctx.db, new Date('2026-07-10T04:29:01Z'));
    const session = await ctx.db
      .selectFrom('training_sessions')
      .select(['status', 'archived_sets_logged', 'last_set_at'])
      .executeTakeFirstOrThrow();
    expect(session.status).toBe('completed');
    expect(session.archived_sets_logged).toBe(2);
    expect(session.last_set_at.toISOString()).toBe('2026-07-10T00:29:00.000Z');
  });

  it('keeps the live set-log response shape when the ledger hook fails', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await sql`DROP TABLE training_sessions`.execute(ctx.db);

    const response = await request(ctx.app).post('/sets/log').set(auth(ctx.traineeToken)).send({
      plan_exercise_id: plan.planExerciseId,
      set_index: 0,
      weight_kg: '100.00',
      reps: 5,
      completed: true,
    });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ id: expect.any(String), logged_at: expect.any(String) });
  });
});
