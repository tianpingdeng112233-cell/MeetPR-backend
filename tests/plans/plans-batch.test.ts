import { sql } from 'kysely';
import { request } from '../helpers/inMemoryRequest';
import { describe, expect, it } from 'vitest';

import { normalizeDateOnly } from '../../src/utils/date';
import type { TestContext } from '../helpers/studentActions';
import { auth, createPublishedPlan, ids, makeContext } from '../helpers/studentActions';

async function makeBatchContext(pushEnabled = false) {
  const ctx = await makeContext(undefined, { config: { PUSH_ENABLED: pushEnabled } });
  // pg-mem returns NUMERIC as a number, unlike node-postgres, which returns the
  // production NUMERIC(6,2) value as a scale-preserving string.
  await sql`ALTER TABLE plan_sets ALTER COLUMN target_value TYPE TEXT`.execute(ctx.db);
  return ctx;
}

function setBody(setNumber = 1, targetValue = '100') {
  return {
    set_number: setNumber,
    target_reps: 5,
    target_reps_max: null,
    intensity_mode: 'weight',
    target_value: targetValue,
    set_type: 'working',
    rest_seconds: null,
    coach_note: null,
  } as const;
}

function upsertDay(weekNumber: number, dayOfWeek: number) {
  return {
    week_number: weekNumber,
    day_of_week: dayOfWeek,
    sort_order: 0,
    exercises: [
      {
        exercise_id: ids.exercise,
        is_main_lift: true,
        sort_order: 0,
        notes: null,
        sets: [setBody()],
      },
    ],
  };
}

async function createDraftPlan(ctx: TestContext, name = 'Batch draft') {
  return ctx.db
    .insertInto('plans')
    .values({
      coach_id: ids.coach,
      trainee_id: ids.trainee,
      name,
      start_date: '2026-07-01',
      end_date: '2026-07-31',
      plan_weeks: 5,
      source: 'coach',
      source_template_id: null,
      status: 'draft',
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

async function addDayTree(ctx: TestContext, planId: string, weekNumber: number, dayOfWeek: number) {
  const day = await ctx.db
    .insertInto('plan_days')
    .values({
      plan_id: planId,
      week_number: weekNumber,
      day_of_week: dayOfWeek,
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
  const set = await ctx.db
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
      coach_note: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { dayId: day.id, exerciseId: exercise.id, setId: set.id };
}

async function addSetLog(ctx: TestContext, planExerciseId: string) {
  return ctx.db
    .insertInto('set_logs')
    .values({
      student_id: ids.trainee,
      plan_exercise_id: planExerciseId,
      exercise_id: ids.exercise,
      set_index: 0,
      weight_kg: '100.00',
      reps: 5,
      completed: true,
      failed: false,
      logged_date: '2026-07-01',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
}

async function treeCounts(ctx: TestContext, planId: string) {
  const days = await ctx.db
    .selectFrom('plan_days')
    .select('id')
    .where('plan_id', '=', planId)
    .execute();
  const dayIds = days.map((day) => day.id);
  const exercises =
    dayIds.length === 0
      ? []
      : await ctx.db
          .selectFrom('plan_exercises')
          .select('id')
          .where('plan_day_id', 'in', dayIds)
          .execute();
  const exerciseIds = exercises.map((exercise) => exercise.id);
  const sets =
    exerciseIds.length === 0
      ? []
      : await ctx.db
          .selectFrom('plan_sets')
          .select('id')
          .where('plan_exercise_id', 'in', exerciseIds)
          .execute();
  return { days: days.length, exercises: exercises.length, sets: sets.length };
}

function batch(ctx: TestContext, planId: string, body: object, token = ctx.coachToken) {
  return request(ctx.app).post(`/plans/${planId}/days/batch`).set(auth(token)).send(body);
}

describe('POST /plans/:id/days/batch', () => {
  it('enqueues plan_updated and bumps updated_at for a published plan tree change', async () => {
    const ctx = await makeBatchContext(true);
    const plan = await createPublishedPlan(ctx);
    const previousUpdatedAt = new Date('2020-01-01T00:00:00.000Z');
    await ctx.db
      .updateTable('plans')
      .set({ updated_at: previousUpdatedAt })
      .where('id', '=', plan.planId)
      .execute();

    const response = await batch(ctx, plan.planId, {
      delete_day_ids: [],
      upsert_days: [upsertDay(2, 2)],
    });
    const rows = await ctx.db
      .selectFrom('notification_outbox')
      .selectAll()
      .where('event_type', '=', 'plan_updated')
      .execute();

    expect(response.status).toBe(200);
    expect(new Date(response.body.updated_at).getTime()).toBeGreaterThan(
      previousUpdatedAt.getTime(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipient_id: ids.trainee,
      status: 'pending',
      payload: {
        coach_name: 'Coach A',
        student_id: ids.trainee,
        plan_id: plan.planId,
      },
    });
    expect(rows[0]?.aggregate_id).not.toBe(plan.planId);
  });

  it('enqueues separate plan_updated rows for consecutive batches on one plan', async () => {
    const ctx = await makeBatchContext(true);
    const plan = await createPublishedPlan(ctx);

    const first = await batch(ctx, plan.planId, {
      delete_day_ids: [],
      upsert_days: [upsertDay(2, 2)],
    });
    const second = await batch(ctx, plan.planId, {
      delete_day_ids: [],
      upsert_days: [upsertDay(2, 3)],
    });
    const rows = await ctx.db
      .selectFrom('notification_outbox')
      .select('aggregate_id')
      .where('event_type', '=', 'plan_updated')
      .execute();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.aggregate_id))).toHaveProperty('size', 2);
  });

  it('does not enqueue plan_updated for a draft plan tree change', async () => {
    const ctx = await makeBatchContext(true);
    const plan = await createDraftPlan(ctx);

    const response = await batch(ctx, plan.id, {
      delete_day_ids: [],
      upsert_days: [upsertDay(1, 1)],
    });
    const rows = await ctx.db
      .selectFrom('notification_outbox')
      .select('id')
      .where('event_type', '=', 'plan_updated')
      .execute();

    expect(response.status).toBe(200);
    expect(rows).toEqual([]);
  });

  it('does not enqueue plan_updated for a published plan name-only patch', async () => {
    const ctx = await makeBatchContext(true);
    const plan = await createPublishedPlan(ctx);

    const response = await batch(ctx, plan.planId, {
      plan_patch: { name: 'Renamed published plan' },
      delete_day_ids: [],
      upsert_days: [],
    });
    const rows = await ctx.db
      .selectFrom('notification_outbox')
      .select('id')
      .where('event_type', '=', 'plan_updated')
      .execute();

    expect(response.status).toBe(200);
    expect(response.body.name).toBe('Renamed published plan');
    expect(rows).toEqual([]);
  });

  it('upserts days, exercises, and batched sets and returns the sorted normalized tree', async () => {
    const ctx = await makeBatchContext();
    const plan = await createDraftPlan(ctx);

    const response = await batch(ctx, plan.id, {
      delete_day_ids: [],
      upsert_days: [
        upsertDay(2, 2),
        {
          week_number: 1,
          day_of_week: 1,
          sort_order: 0,
          exercises: [
            {
              exercise_id: ids.exercise,
              is_main_lift: true,
              sort_order: 0,
              notes: 'main work',
              sets: [setBody(2, '105.5'), setBody(1, '100')],
            },
          ],
        },
      ],
    });

    expect(response.status).toBe(200);
    expect(
      response.body.days.map((day: { week_number: number; day_of_week: number }) => [
        day.week_number,
        day.day_of_week,
      ]),
    ).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(response.body.days[0].exercises[0]).toMatchObject({
      exercise_id: ids.exercise,
      notes: 'main work',
      has_logs: false,
    });
    expect(
      response.body.days[0].exercises[0].sets.map(
        (set: { set_number: number; target_value: string }) => [set.set_number, set.target_value],
      ),
    ).toEqual([
      [1, '100.00'],
      [2, '105.50'],
    ]);
    expect(await treeCounts(ctx, plan.id)).toEqual({ days: 2, exercises: 2, sets: 3 });
  });

  it('deletes selected days and cascades their exercises and sets', async () => {
    const ctx = await makeBatchContext();
    const plan = await createPublishedPlan(ctx);
    const oldSet = await ctx.db
      .selectFrom('plan_sets')
      .select('id')
      .where('plan_exercise_id', '=', plan.planExerciseId)
      .executeTakeFirstOrThrow();

    const response = await batch(ctx, plan.planId, {
      delete_day_ids: [plan.dayId],
      upsert_days: [],
    });

    expect(response.status).toBe(200);
    expect(response.body.days).toEqual([]);
    expect(
      await ctx.db
        .selectFrom('plan_exercises')
        .select('id')
        .where('id', '=', plan.planExerciseId)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(
      await ctx.db
        .selectFrom('plan_sets')
        .select('id')
        .where('id', '=', oldSet.id)
        .executeTakeFirst(),
    ).toBeUndefined();
  });

  it('replaces only B day and preserves published A day with its set-log history', async () => {
    const ctx = await makeBatchContext();
    const plan = await createPublishedPlan(ctx);
    const dayB = await addDayTree(ctx, plan.planId, 1, 2);
    const setLog = await addSetLog(ctx, plan.planExerciseId);

    const response = await batch(ctx, plan.planId, {
      delete_day_ids: [dayB.dayId],
      upsert_days: [upsertDay(1, 2)],
    });

    expect(response.status).toBe(200);
    expect(response.body.days).toHaveLength(2);
    expect(response.body.days.map((day: { id: string }) => day.id)).toContain(plan.dayId);
    expect(response.body.days.map((day: { id: string }) => day.id)).not.toContain(dayB.dayId);
    expect(
      await ctx.db
        .selectFrom('plan_days')
        .select('id')
        .where('id', '=', plan.dayId)
        .executeTakeFirst(),
    ).toEqual({ id: plan.dayId });
    expect(
      await ctx.db
        .selectFrom('set_logs')
        .select(['id', 'plan_exercise_id'])
        .where('id', '=', setLog.id)
        .executeTakeFirst(),
    ).toEqual({ id: setLog.id, plan_exercise_id: plan.planExerciseId });
  });

  it('hides non-owned plans and scopes foreign delete IDs to the owned plan', async () => {
    const ctx = await makeBatchContext();
    const ownPlan = await createDraftPlan(ctx);
    const foreignPlan = await createPublishedPlan(ctx, ids.otherCoach, ids.otherStudent);

    const hidden = await batch(ctx, foreignPlan.planId, {
      delete_day_ids: [],
      upsert_days: [],
    });
    const scoped = await batch(ctx, ownPlan.id, {
      delete_day_ids: [foreignPlan.dayId],
      upsert_days: [upsertDay(1, 3)],
    });

    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual({ error: 'PLAN_NOT_FOUND' });
    expect(scoped.status).toBe(200);
    expect(scoped.body.days).toHaveLength(1);
    expect(
      await ctx.db
        .selectFrom('plan_days')
        .select('id')
        .where('id', '=', foreignPlan.dayId)
        .executeTakeFirst(),
    ).toEqual({ id: foreignPlan.dayId });
  });

  it('rejects hidden exercises as one visibility gate with zero tree writes', async () => {
    const ctx = await makeBatchContext();
    const plan = await createDraftPlan(ctx);
    const hidden = await ctx.db
      .insertInto('exercises')
      .values({
        name: 'Other coach private movement',
        exercise_type: 'accessory',
        main_lift_family: null,
        is_competition_lift: false,
        muscle_groups: ['back'],
        equipment: ['barbell'],
        movement_pattern: ['horizontal_pull'],
        created_by_coach_id: ids.otherCoach,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const before = await treeCounts(ctx, plan.id);

    const response = await batch(ctx, plan.id, {
      delete_day_ids: [],
      upsert_days: [
        {
          ...upsertDay(1, 1),
          exercises: [
            {
              exercise_id: hidden.id,
              is_main_lift: false,
              sort_order: 0,
              sets: [setBody()],
            },
          ],
        },
      ],
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'EXERCISE_NOT_FOUND_OR_HIDDEN',
      details: { exercise_ids: [hidden.id] },
    });
    expect(await treeCounts(ctx, plan.id)).toEqual(before);
  });

  it.each([3, null])('keeps batch calendar updates consistent with anchor %s', async (anchor) => {
    const ctx = await makeBatchContext();
    const plan = await createDraftPlan(ctx);
    await ctx.db
      .updateTable('plans')
      .set({ anchor_weekday: anchor })
      .where('id', '=', plan.id)
      .execute();
    const updated = await batch(ctx, plan.id, {
      plan_patch: { start_date: '2026-07-05' },
      delete_day_ids: [],
      upsert_days: [upsertDay(1, 1)],
    });
    expect(updated.status).toBe(200);
    expect(updated.body.anchor_weekday).toBe(anchor === null ? null : 7);
    const loaded = await request(ctx.app).get(`/plans/${plan.id}`).set(auth(ctx.coachToken));
    expect(loaded.status).toBe(200);
    expect(loaded.body.anchor_weekday).toBe(anchor === null ? null : 7);
    expect(normalizeDateOnly(new Date(loaded.body.start_date))).toBe('2026-07-05');
  });

  it('updates plan calendar fields atomically and rejects merged inverted dates without writes', async () => {
    const ctx = await makeBatchContext();
    const plan = await createDraftPlan(ctx);

    const updated = await batch(ctx, plan.id, {
      plan_patch: {
        plan_weeks: 4,
        start_date: '2026-07-06',
        end_date: '2026-08-02',
      },
      delete_day_ids: [],
      upsert_days: [upsertDay(1, 1)],
    });
    const beforeRejected = await treeCounts(ctx, plan.id);
    const rejected = await batch(ctx, plan.id, {
      plan_patch: { end_date: '2026-07-05' },
      delete_day_ids: [],
      upsert_days: [upsertDay(2, 2)],
    });
    const stored = await ctx.db
      .selectFrom('plans')
      .select(['start_date', 'end_date', 'plan_weeks'])
      .where('id', '=', plan.id)
      .executeTakeFirstOrThrow();

    expect(updated.status).toBe(200);
    // pg-mem surfaces DATE columns as Date objects, which JSON-serialize to
    // full ISO timestamps (prod pg's OID 1082 text parser returns plain date
    // strings); compare on the date part only.
    expect(String(updated.body.start_date).slice(0, 10)).toBe('2026-07-06');
    expect(String(updated.body.end_date).slice(0, 10)).toBe('2026-08-02');
    expect(updated.body.plan_weeks).toBe(4);
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe('VALIDATION_ERROR');
    expect(normalizeDateOnly(stored.start_date)).toBe('2026-07-06');
    expect(normalizeDateOnly(stored.end_date)).toBe('2026-08-02');
    expect(stored.plan_weeks).toBe(4);
    expect(await treeCounts(ctx, plan.id)).toEqual(beforeRejected);
  });

  it('enforces the 100-day and 30-set batch bounds', async () => {
    const ctx = await makeBatchContext();
    const plan = await createDraftPlan(ctx);
    const before = await treeCounts(ctx, plan.id);

    const tooManyDays = await batch(ctx, plan.id, {
      delete_day_ids: [],
      upsert_days: Array.from({ length: 101 }, () => ({
        week_number: 1,
        day_of_week: 1,
        sort_order: 0,
        exercises: [],
      })),
    });
    const tooManySets = await batch(ctx, plan.id, {
      delete_day_ids: [],
      upsert_days: [
        {
          ...upsertDay(1, 1),
          exercises: [
            {
              exercise_id: ids.exercise,
              is_main_lift: true,
              sort_order: 0,
              sets: Array.from({ length: 31 }, (_, index) => setBody(index + 1)),
            },
          ],
        },
      ],
    });

    expect(tooManyDays.status).toBe(400);
    expect(tooManySets.status).toBe(400);
    expect(await treeCounts(ctx, plan.id)).toEqual(before);
  });

  it('requires the coach role', async () => {
    const ctx = await makeBatchContext();
    const plan = await createDraftPlan(ctx);

    const response = await batch(
      ctx,
      plan.id,
      { delete_day_ids: [], upsert_days: [] },
      ctx.traineeToken,
    );

    expect(response.status).toBe(403);
    expect(await treeCounts(ctx, plan.id)).toEqual({ days: 0, exercises: 0, sets: 0 });
  });

  it('accepts an empty operation and leaves the plan unchanged', async () => {
    const ctx = await makeBatchContext(true);
    const plan = await createPublishedPlan(ctx);
    const before = await treeCounts(ctx, plan.planId);
    const beforePlan = await ctx.db
      .selectFrom('plans')
      .select('updated_at')
      .where('id', '=', plan.planId)
      .executeTakeFirstOrThrow();

    const response = await batch(ctx, plan.planId, {
      delete_day_ids: [],
      upsert_days: [],
    });

    expect(response.status).toBe(200);
    expect(response.body.days).toHaveLength(1);
    expect(response.body.days[0].id).toBe(plan.dayId);
    expect(await treeCounts(ctx, plan.planId)).toEqual(before);
    expect(new Date(response.body.updated_at)).toEqual(beforePlan.updated_at);
    expect(
      await ctx.db
        .selectFrom('notification_outbox')
        .select('id')
        .where('event_type', '=', 'plan_updated')
        .execute(),
    ).toEqual([]);
  });

  it('rejects a frozen deleted day with day IDs and rolls back the full transaction', async () => {
    const ctx = await makeBatchContext();
    const plan = await createPublishedPlan(ctx);
    const setLog = await addSetLog(ctx, plan.planExerciseId);
    const before = await treeCounts(ctx, plan.planId);

    const response = await batch(ctx, plan.planId, {
      plan_patch: { name: 'Must not apply' },
      delete_day_ids: [plan.dayId],
      upsert_days: [upsertDay(2, 2)],
    });
    const storedPlan = await ctx.db
      .selectFrom('plans')
      .select('name')
      .where('id', '=', plan.planId)
      .executeTakeFirstOrThrow();

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: 'DAY_HISTORY_IMMUTABLE',
      details: { day_ids: [plan.dayId] },
    });
    expect(storedPlan.name).toBe('Published Block');
    expect(await treeCounts(ctx, plan.planId)).toEqual(before);
    expect(
      await ctx.db
        .selectFrom('set_logs')
        .select('id')
        .where('id', '=', setLog.id)
        .executeTakeFirst(),
    ).toEqual({ id: setLog.id });
  });

  it('extends a plan with history before adding new weeks and enqueues one plan_updated', async () => {
    const ctx = await makeBatchContext(true);
    const plan = await createPublishedPlan(ctx);
    const setLog = await addSetLog(ctx, plan.planExerciseId);
    const historyBefore = await ctx.db
      .selectFrom('set_logs')
      .selectAll()
      .where('id', '=', setLog.id)
      .executeTakeFirstOrThrow();
    const before = await request(ctx.app).get(`/plans/${plan.planId}`).set(auth(ctx.coachToken));
    expect(before.status).toBe(200);

    const response = await batch(ctx, plan.planId, {
      plan_patch: { plan_weeks: 6, end_date: '2026-06-11' },
      upsert_days: [upsertDay(5, 1), upsertDay(6, 1)],
    });

    expect(response.status).toBe(200);
    const loaded = await request(ctx.app).get(`/plans/${plan.planId}`).set(auth(ctx.coachToken));
    expect(loaded.status).toBe(200);
    expect(new Date(loaded.body.start_date)).toEqual(new Date('2026-05-01'));
    expect(new Date(loaded.body.end_date)).toEqual(new Date('2026-06-11'));
    expect(loaded.body).toMatchObject({
      plan_weeks: 6,
      days: [before.body.days[0], { week_number: 5 }, { week_number: 6 }],
    });
    expect(loaded.body.days[0]).toEqual(before.body.days[0]);
    expect(
      await ctx.db
        .selectFrom('set_logs')
        .selectAll()
        .where('id', '=', setLog.id)
        .executeTakeFirst(),
    ).toEqual(historyBefore);
    expect(
      await ctx.db
        .selectFrom('notification_outbox')
        .select(['event_type', 'recipient_id'])
        .where('event_type', '=', 'plan_updated')
        .execute(),
    ).toEqual([{ event_type: 'plan_updated', recipient_id: ids.trainee }]);
  });

  it.each([
    { plan_weeks: 3, end_date: '2026-06-11' },
    { end_date: '2026-05-27', plan_weeks: 6 },
    { start_date: '2026-05-02', plan_weeks: 6 },
  ])('rejects a non-extension %j without writing new days', async (planPatch) => {
    const ctx = await makeBatchContext();
    const plan = await createPublishedPlan(ctx);
    await addSetLog(ctx, plan.planExerciseId);
    const before = await request(ctx.app).get(`/plans/${plan.planId}`).set(auth(ctx.coachToken));

    const response = await batch(ctx, plan.planId, {
      plan_patch: planPatch,
      upsert_days: [upsertDay(5, 1)],
    });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'PLAN_HISTORY_IMMUTABLE' });
    const loaded = await request(ctx.app).get(`/plans/${plan.planId}`).set(auth(ctx.coachToken));
    expect(loaded.status).toBe(200);
    expect(loaded.body).toEqual(before.body);
  });

  it('keeps deletion of a day with history locked even alongside a pure extension', async () => {
    const ctx = await makeBatchContext(true);
    const plan = await createPublishedPlan(ctx);
    await addSetLog(ctx, plan.planExerciseId);
    const before = await request(ctx.app).get(`/plans/${plan.planId}`).set(auth(ctx.coachToken));

    const response = await batch(ctx, plan.planId, {
      plan_patch: { plan_weeks: 6, end_date: '2026-06-11' },
      delete_day_ids: [plan.dayId],
      upsert_days: [upsertDay(5, 1)],
    });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: 'DAY_HISTORY_IMMUTABLE',
      details: { day_ids: [plan.dayId] },
    });
    const loaded = await request(ctx.app).get(`/plans/${plan.planId}`).set(auth(ctx.coachToken));
    expect(loaded.status).toBe(200);
    expect(loaded.body).toEqual(before.body);
    expect(await ctx.db.selectFrom('notification_outbox').select('id').execute()).toEqual([]);
  });

  it('locks calendar patches for any plan history, rolls back tree writes, and permits name-only patches', async () => {
    const ctx = await makeBatchContext();
    const plan = await createPublishedPlan(ctx);
    const dayB = await addDayTree(ctx, plan.planId, 1, 2);
    await addSetLog(ctx, plan.planExerciseId);
    const before = await treeCounts(ctx, plan.planId);

    const locked = await batch(ctx, plan.planId, {
      plan_patch: { start_date: '2026-05-02', plan_weeks: 5 },
      delete_day_ids: [dayB.dayId],
      upsert_days: [upsertDay(2, 3)],
    });
    const storedAfterLocked = await ctx.db
      .selectFrom('plans')
      .select(['name', 'start_date', 'plan_weeks'])
      .where('id', '=', plan.planId)
      .executeTakeFirstOrThrow();
    const renamed = await batch(ctx, plan.planId, {
      plan_patch: { name: 'Published rename is allowed' },
      delete_day_ids: [],
      upsert_days: [],
    });

    expect(locked.status).toBe(409);
    expect(locked.body).toEqual({ error: 'PLAN_HISTORY_IMMUTABLE' });
    expect(normalizeDateOnly(storedAfterLocked.start_date)).toBe('2026-05-01');
    expect(storedAfterLocked.plan_weeks).toBe(4);
    expect(await treeCounts(ctx, plan.planId)).toEqual(before);
    expect(
      await ctx.db
        .selectFrom('plan_days')
        .select('id')
        .where('id', '=', dayB.dayId)
        .executeTakeFirst(),
    ).toEqual({ id: dayB.dayId });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Published rename is allowed');
  });
});

it('retains a resting prescription durably for its coach without exposing it to students', async () => {
  const ctx = await makeContext(undefined, { config: { PLAN_REST_DAYS_ENABLED: true } });
  const plan = await createPublishedPlan(ctx);
  const before = await request(ctx.app).get(`/plans/${plan.planId}`).set(auth(ctx.coachToken));
  const resting = await batch(ctx, plan.planId, {
    day_types: [{ day_id: plan.dayId, is_rest: true }],
  });
  expect(resting.status).toBe(200);
  const coach = await request(ctx.app)
    .get(`/plans/${plan.planId}?include_rest_days=true`)
    .set(auth(ctx.coachToken));
  expect(coach.body.rest_days_enabled).toBe(true);
  expect(coach.body.days[0]).toMatchObject({ ...before.body.days[0], is_rest: true });
  const student = await request(ctx.app).get(`/plans/${plan.planId}`).set(auth(ctx.traineeToken));
  expect(student.body.days).toEqual([]);
  const legacyCoach = await request(ctx.app).get(`/plans/${plan.planId}`).set(auth(ctx.coachToken));
  expect(legacyCoach.body.days).toEqual([]);
  const restored = await batch(ctx, plan.planId, {
    day_types: [{ day_id: plan.dayId, is_rest: false }],
  });
  expect(restored.status).toBe(200);
  const after = await request(ctx.app).get(`/plans/${plan.planId}`).set(auth(ctx.traineeToken));
  expect(after.body.days).toEqual(before.body.days);
  await ctx.db.destroy();
});

it('refuses a cached student logging or completing a rest day', async () => {
  const ctx = await makeContext(undefined, { config: { PLAN_REST_DAYS_ENABLED: true } });
  const plan = await createPublishedPlan(ctx);
  expect(
    (await batch(ctx, plan.planId, { day_types: [{ day_id: plan.dayId, is_rest: true }] })).status,
  ).toBe(200);
  const log = await request(ctx.app).post('/sets/log').set(auth(ctx.traineeToken)).send({
    plan_exercise_id: plan.planExerciseId,
    set_index: 0,
    weight_kg: '100',
    reps: 5,
    completed: true,
  });
  expect(log.status).toBe(400);
  const completion = await request(ctx.app)
    .post(`/plans/days/${plan.dayId}/complete`)
    .set(auth(ctx.traineeToken))
    .send({});
  expect(completion.status).toBe(409);
  await ctx.db.destroy();
});

it('publishes active training without treating an empty rest day as incomplete', async () => {
  const ctx = await makeContext(undefined, { config: { PLAN_REST_DAYS_ENABLED: true } });
  const plan = await createDraftPlan(ctx);
  const stored = await batch(ctx, plan.id, {
    day_types: [],
    upsert_days: [upsertDay(1, 1), { ...upsertDay(1, 2), exercises: [], is_rest: true }],
  });
  expect(stored.status).toBe(200);
  const published = await request(ctx.app)
    .post(`/plans/${plan.id}/publish`)
    .set(auth(ctx.coachToken))
    .send({});
  expect(published.status).toBe(200);
  await ctx.db.destroy();
});

it('rejects a completed day switch before applying any other day switch', async () => {
  const ctx = await makeContext(undefined, { config: { PLAN_REST_DAYS_ENABLED: true } });
  const plan = await createPublishedPlan(ctx);
  const another = await addDayTree(ctx, plan.planId, 1, 2);
  expect(
    (
      await request(ctx.app)
        .post(`/plans/days/${another.dayId}/complete`)
        .set(auth(ctx.traineeToken))
        .send({})
    ).status,
  ).toBe(200);
  const changed = await batch(ctx, plan.planId, {
    day_types: [
      { day_id: plan.dayId, is_rest: true },
      { day_id: another.dayId, is_rest: true },
    ],
  });
  expect(changed.status).toBe(409);
  expect(changed.body.error).toBe('DAY_HISTORY_IMMUTABLE');
  const after = await request(ctx.app)
    .get(`/plans/${plan.planId}?include_rest_days=true`)
    .set(auth(ctx.coachToken));
  expect(after.body.days.map((day: { is_rest: boolean }) => day.is_rest)).toEqual([false, false]);
  await ctx.db.destroy();
});

it('keeps the feature off by default while retaining legacy batch behavior', async () => {
  const ctx = await makeBatchContext();
  const plan = await createPublishedPlan(ctx);
  const disabled = await batch(ctx, plan.planId, {
    day_types: [{ day_id: plan.dayId, is_rest: true }],
  });
  expect(disabled.status).toBe(409);
  expect(disabled.body.error).toBe('REST_DAYS_DISABLED');
  expect((await batch(ctx, plan.planId, { upsert_days: [upsertDay(2, 2)] })).status).toBe(200);
  await ctx.db.destroy();
});

it('atomically refuses restoring an empty live training day while allowing empty rests', async () => {
  const ctx = await makeContext(undefined, { config: { PLAN_REST_DAYS_ENABLED: true } });
  const plan = await createPublishedPlan(ctx);
  const added = await batch(ctx, plan.planId, {
    upsert_days: [{ ...upsertDay(1, 2), exercises: [], is_rest: true }],
  });
  expect(added.status).toBe(200);
  const empty = added.body.days.find((day: { day_of_week: number }) => day.day_of_week === 2);
  const restore = await batch(ctx, plan.planId, {
    day_types: [
      { day_id: plan.dayId, is_rest: true },
      { day_id: empty.id, is_rest: false },
    ],
  });
  expect(restore.status).toBe(422);
  const after = await request(ctx.app)
    .get(`/plans/${plan.planId}?include_rest_days=true`)
    .set(auth(ctx.coachToken));
  expect(after.body.days.map((day: { is_rest: boolean }) => day.is_rest)).toEqual([false, true]);
  await ctx.db.destroy();
});
