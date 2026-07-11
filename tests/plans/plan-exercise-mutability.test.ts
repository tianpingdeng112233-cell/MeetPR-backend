import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { normalizeDateOnly } from '../../src/utils/date';
import type { TestContext } from '../helpers/studentActions';
import { auth, createPublishedPlan, ids, makeContext } from '../helpers/studentActions';

async function addPlanExercise(ctx: TestContext, dayId: string, sortOrder: number) {
  const exercise = await ctx.db
    .insertInto('plan_exercises')
    .values({
      plan_day_id: dayId,
      exercise_id: ids.exercise,
      is_main_lift: false,
      sort_order: sortOrder,
      notes: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const set = await ctx.db
    .insertInto('plan_sets')
    .values({
      plan_exercise_id: exercise.id,
      set_number: 1,
      target_reps: 8,
      target_reps_max: null,
      intensity_mode: 'weight',
      target_value: '80.00',
      set_type: 'working',
      rest_seconds: null,
      coach_note: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { exerciseId: exercise.id, setId: set.id };
}

async function addSetLog(
  ctx: TestContext,
  planExerciseId: string | null,
  setIndex = 0,
  assumed = false,
) {
  await ctx.db
    .insertInto('set_logs')
    .values({
      student_id: ids.trainee,
      plan_exercise_id: planExerciseId,
      exercise_id: ids.exercise,
      set_index: setIndex,
      weight_kg: '100.00',
      reps: 5,
      completed: true,
      failed: false,
      assumed,
      adhoc: planExerciseId === null,
      logged_date: '2026-05-01',
    })
    .execute();
}

function newSetBody(setNumber = 2) {
  return {
    set_number: setNumber,
    target_reps: 5,
    target_reps_max: null,
    intensity_mode: 'weight',
    target_value: '90',
    set_type: 'working',
    rest_seconds: null,
    coach_note: null,
  } as const;
}

function queryGate(matches: (sql: string) => boolean) {
  let resume!: () => void;
  let reached!: () => void;
  let paused = false;
  const reachedPromise = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const resumePromise = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const queries: string[] = [];
  return {
    afterQuery: async (sql: string) => {
      queries.push(sql);
      if (paused || !matches(sql)) return;
      paused = true;
      reached();
      await resumePromise;
    },
    reached: reachedPromise,
    resume,
    queries,
  };
}

function lockedTableOrder(queries: string[]): string[] {
  return queries
    .filter((sql) => sql.includes('for update'))
    .map((sql) =>
      ['plans', 'plan_days', 'plan_exercises'].find((table) => sql.includes(`from "${table}"`)),
    )
    .filter((table): table is string => table !== undefined);
}

describe('spec 016 plan tree mutability', () => {
  it('allows every mutation class on a published exercise with no logs', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    const originalSet = await ctx.db
      .selectFrom('plan_sets')
      .select('id')
      .where('plan_exercise_id', '=', plan.planExerciseId)
      .executeTakeFirstOrThrow();

    const patchDay = await request(ctx.app)
      .patch(`/plans/days/${plan.dayId}`)
      .set(auth(ctx.coachToken))
      .send({ sort_order: 4 });
    const patchExercise = await request(ctx.app)
      .patch(`/plans/exercises/${plan.planExerciseId}`)
      .set(auth(ctx.coachToken))
      .send({ notes: 'still editable' });
    const patchSet = await request(ctx.app)
      .patch(`/plans/sets/${originalSet.id}`)
      .set(auth(ctx.coachToken))
      .send({ target_reps: 6 });
    const createSet = await request(ctx.app)
      .post(`/plans/exercises/${plan.planExerciseId}/sets`)
      .set(auth(ctx.coachToken))
      .send(newSetBody());
    const deleteSet = await request(ctx.app)
      .delete(`/plans/sets/${String(createSet.body.id)}`)
      .set(auth(ctx.coachToken));
    const deleteExercise = await request(ctx.app)
      .delete(`/plans/exercises/${plan.planExerciseId}`)
      .set(auth(ctx.coachToken));
    const deleteDay = await request(ctx.app)
      .delete(`/plans/days/${plan.dayId}`)
      .set(auth(ctx.coachToken));

    expect(patchDay.status).toBe(200);
    expect(patchExercise.status).toBe(200);
    expect(patchExercise.body).toMatchObject({ has_logs: false, notes: 'still editable' });
    expect(patchSet.status).toBe(200);
    expect(createSet.status).toBe(201);
    expect(deleteSet.status).toBe(204);
    expect(deleteExercise.status).toBe(204);
    expect(deleteDay.status).toBe(204);
  });

  it('freezes a logged exercise and all of its sets with row-level details', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    const set = await ctx.db
      .selectFrom('plan_sets')
      .select('id')
      .where('plan_exercise_id', '=', plan.planExerciseId)
      .executeTakeFirstOrThrow();
    await addSetLog(ctx, plan.planExerciseId);
    const expected = {
      error: 'EXERCISE_HISTORY_IMMUTABLE',
      details: { exercise_ids: [plan.planExerciseId] },
    };

    const responses = await Promise.all([
      request(ctx.app)
        .patch(`/plans/exercises/${plan.planExerciseId}`)
        .set(auth(ctx.coachToken))
        .send({ notes: 'blocked' }),
      request(ctx.app).delete(`/plans/exercises/${plan.planExerciseId}`).set(auth(ctx.coachToken)),
      request(ctx.app)
        .post(`/plans/exercises/${plan.planExerciseId}/sets`)
        .set(auth(ctx.coachToken))
        .send(newSetBody()),
      request(ctx.app)
        .patch(`/plans/sets/${set.id}`)
        .set(auth(ctx.coachToken))
        .send({ target_reps: 3 }),
      request(ctx.app).delete(`/plans/sets/${set.id}`).set(auth(ctx.coachToken)),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(409);
      expect(response.body).toEqual(expected);
    }
  });

  it('keeps only the logged row frozen in a mixed day and permits additive writes', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    const mutable = await addPlanExercise(ctx, plan.dayId, 1);
    await addSetLog(ctx, plan.planExerciseId);

    const patchMutable = await request(ctx.app)
      .patch(`/plans/exercises/${mutable.exerciseId}`)
      .set(auth(ctx.coachToken))
      .send({ notes: 'future prescription' });
    const patchMutableSet = await request(ctx.app)
      .patch(`/plans/sets/${mutable.setId}`)
      .set(auth(ctx.coachToken))
      .send({ target_reps: 10 });
    const addExercise = await request(ctx.app)
      .post(`/plans/days/${plan.dayId}/exercises`)
      .set(auth(ctx.coachToken))
      .send({ exercise_id: ids.exercise, is_main_lift: false, sort_order: 2, notes: null });
    const addDay = await request(ctx.app)
      .post(`/plans/${plan.planId}/days`)
      .set(auth(ctx.coachToken))
      .send({ day_of_week: 2, week_number: 1, sort_order: 1 });
    const patchDay = await request(ctx.app)
      .patch(`/plans/days/${plan.dayId}`)
      .set(auth(ctx.coachToken))
      .send({ sort_order: 9 });
    const deleteDay = await request(ctx.app)
      .delete(`/plans/days/${plan.dayId}`)
      .set(auth(ctx.coachToken));

    expect(patchMutable.status).toBe(200);
    expect(patchMutableSet.status).toBe(200);
    expect(addExercise.status).toBe(201);
    expect(addExercise.body.has_logs).toBe(false);
    expect(addDay.status).toBe(201);
    const expectedDayError = {
      error: 'DAY_HISTORY_IMMUTABLE',
      details: { day_id: plan.dayId, exercise_ids: [plan.planExerciseId] },
    };
    expect(patchDay.status).toBe(409);
    expect(patchDay.body).toEqual(expectedDayError);
    expect(deleteDay.status).toBe(409);
    expect(deleteDay.body).toEqual(expectedDayError);

    const deleteMutable = await request(ctx.app)
      .delete(`/plans/exercises/${mutable.exerciseId}`)
      .set(auth(ctx.coachToken));
    expect(deleteMutable.status).toBe(204);
  });

  it('applies the same freeze to draft imported history', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    const mutable = await addPlanExercise(ctx, plan.dayId, 1);
    await ctx.db
      .updateTable('plans')
      .set({ status: 'draft' })
      .where('id', '=', plan.planId)
      .execute();
    await addSetLog(ctx, plan.planExerciseId, 0, true);

    const frozen = await request(ctx.app)
      .patch(`/plans/exercises/${plan.planExerciseId}`)
      .set(auth(ctx.coachToken))
      .send({ notes: 'blocked' });
    const editable = await request(ctx.app)
      .patch(`/plans/exercises/${mutable.exerciseId}`)
      .set(auth(ctx.coachToken))
      .send({ notes: 'allowed' });

    expect(frozen.status).toBe(409);
    expect(frozen.body.error).toBe('EXERCISE_HISTORY_IMMUTABLE');
    expect(editable.status).toBe(200);
  });

  it('locks only calendar metadata at plan level and always permits name', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await addSetLog(ctx, plan.planExerciseId);

    const rename = await request(ctx.app)
      .patch(`/plans/${plan.planId}`)
      .set(auth(ctx.coachToken))
      .send({ name: 'Renamed despite history' });
    expect(rename.status).toBe(200);
    expect(rename.body.name).toBe('Renamed despite history');

    for (const patch of [
      { start_date: '2026-04-30' },
      { end_date: '2026-05-29' },
      { plan_weeks: 5 },
      { source_template_id: null },
    ]) {
      const response = await request(ctx.app)
        .patch(`/plans/${plan.planId}`)
        .set(auth(ctx.coachToken))
        .send(patch);
      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: 'PLAN_HISTORY_IMMUTABLE' });
    }
  });

  it('serializes has_logs with one linked aggregation and ignores orphan logs', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    const other = await addPlanExercise(ctx, plan.dayId, 1);
    await addSetLog(ctx, null);

    const withoutLinkedLogs = await request(ctx.app)
      .get(`/plans/${plan.planId}`)
      .set(auth(ctx.coachToken));
    expect(withoutLinkedLogs.status).toBe(200);
    expect(
      (withoutLinkedLogs.body.days[0].exercises as { id: string; has_logs: boolean }[]).map(
        (exercise) => [exercise.id, exercise.has_logs],
      ),
    ).toEqual([
      [plan.planExerciseId, false],
      [other.exerciseId, false],
    ]);

    await addSetLog(ctx, plan.planExerciseId, 1);
    const withLinkedLog = await request(ctx.app)
      .get(`/plans/${plan.planId}`)
      .set(auth(ctx.coachToken));
    expect(
      (withLinkedLog.body.days[0].exercises as { id: string; has_logs: boolean }[]).map(
        (exercise) => [exercise.id, exercise.has_logs],
      ),
    ).toEqual([
      [plan.planExerciseId, true],
      [other.exerciseId, false],
    ]);

    const emptyPlan = await ctx.db
      .insertInto('plans')
      .values({
        coach_id: ids.coach,
        trainee_id: ids.trainee,
        name: 'Empty tree',
        start_date: '2026-06-01',
        end_date: '2026-06-07',
        plan_weeks: 1,
        source: 'coach',
        source_template_id: null,
        status: 'draft',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const emptyTree = await request(ctx.app)
      .get(`/plans/${emptyPlan.id}`)
      .set(auth(ctx.coachToken));
    expect(emptyTree.status).toBe(200);
    expect(emptyTree.body.days).toEqual([]);
  });

  // The three race tests below verify statement ORDER (FOR UPDATE taken before the
  // set_logs check, inside the write transaction) by pausing the handler at the lock
  // query and injecting a log mid-window. pg-mem implements no row locking, so real
  // mutual exclusion (FK KEY SHARE blocked by FOR UPDATE) is not exercised here —
  // that part is Postgres semantics; what the suite pins is the order that makes it apply.
  it('exercise lock closes the check/write race with a concurrent set log', async () => {
    const gate = queryGate(
      (sql) =>
        sql.includes('from "plan_exercises"') &&
        sql.includes('where "id" = $1') &&
        sql.includes('for update'),
    );
    const ctx = await makeContext(undefined, { afterQuery: gate.afterQuery });
    const plan = await createPublishedPlan(ctx);

    const mutation = request(ctx.app)
      .patch(`/plans/exercises/${plan.planExerciseId}`)
      .set(auth(ctx.coachToken))
      .send({ notes: 'racing edit' })
      .then((response) => response);
    await gate.reached;
    await addSetLog(ctx, plan.planExerciseId);
    gate.resume();
    const response = await mutation;

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('EXERCISE_HISTORY_IMMUTABLE');
    expect(lockedTableOrder(gate.queries)).toEqual(['plan_exercises']);
    const exercise = await ctx.db
      .selectFrom('plan_exercises')
      .select('notes')
      .where('id', '=', plan.planExerciseId)
      .executeTakeFirstOrThrow();
    expect(exercise.notes).toBeNull();
  });

  it('day lock ladder closes the child/log race before changing the day', async () => {
    const gate = queryGate(
      (sql) =>
        sql.includes('from "plan_exercises"') &&
        sql.includes('where "plan_day_id" = $1') &&
        sql.includes('for update'),
    );
    const ctx = await makeContext(undefined, { afterQuery: gate.afterQuery });
    const plan = await createPublishedPlan(ctx);

    const mutation = request(ctx.app)
      .patch(`/plans/days/${plan.dayId}`)
      .set(auth(ctx.coachToken))
      .send({ sort_order: 7 })
      .then((response) => response);
    await gate.reached;
    await addSetLog(ctx, plan.planExerciseId);
    gate.resume();
    const response = await mutation;

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('DAY_HISTORY_IMMUTABLE');
    expect(lockedTableOrder(gate.queries)).toEqual(['plan_days', 'plan_exercises']);
    const day = await ctx.db
      .selectFrom('plan_days')
      .select('sort_order')
      .where('id', '=', plan.dayId)
      .executeTakeFirstOrThrow();
    expect(day.sort_order).toBe(0);
  });

  it('plan lock ladder closes the descendant/log race before changing calendar metadata', async () => {
    const gate = queryGate(
      (sql) =>
        sql.includes('from "plan_exercises"') &&
        sql.includes('where "plan_day_id" in') &&
        sql.includes('for update'),
    );
    const ctx = await makeContext(undefined, { afterQuery: gate.afterQuery });
    const plan = await createPublishedPlan(ctx);

    const mutation = request(ctx.app)
      .patch(`/plans/${plan.planId}`)
      .set(auth(ctx.coachToken))
      .send({ start_date: '2026-04-30' })
      .then((response) => response);
    await gate.reached;
    await addSetLog(ctx, plan.planExerciseId);
    gate.resume();
    const response = await mutation;

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'PLAN_HISTORY_IMMUTABLE' });
    expect(lockedTableOrder(gate.queries)).toEqual(['plans', 'plan_days', 'plan_exercises']);
    const lockedPlan = await ctx.db
      .selectFrom('plans')
      .select('start_date')
      .where('id', '=', plan.planId)
      .executeTakeFirstOrThrow();
    expect(normalizeDateOnly(lockedPlan.start_date as string | Date)).toBe('2026-05-01');
  });
});
