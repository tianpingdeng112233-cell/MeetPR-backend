import { sql } from 'kysely';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import type { TestContext } from '../helpers/studentActions';
import { auth, createPublishedPlan, ids, makeContext } from '../helpers/studentActions';

const newFieldDefaults = {
  load_mode: null,
  pct_anchor: null,
  target_pct: null,
  target_rpe: null,
  rir_target: null,
  rpe_low: null,
  rpe_high: null,
  weight_low: null,
  weight_high: null,
  target_weight: null,
};

function baseSet(setNumber: number) {
  return {
    set_number: setNumber,
    target_reps: 5,
    target_reps_max: null,
    set_type: 'working',
  };
}

async function makePlanContext() {
  const ctx = await makeContext();
  await sql`ALTER TABLE plan_sets ALTER COLUMN target_value TYPE TEXT`.execute(ctx.db);
  await sql`ALTER TABLE plan_sets ALTER COLUMN intensity_mode DROP NOT NULL`.execute(ctx.db);
  await sql`ALTER TABLE plan_sets ALTER COLUMN target_value DROP NOT NULL`.execute(ctx.db);
  const plan = await createPublishedPlan(ctx);
  return { ctx, plan };
}

function createSet(ctx: TestContext, planExerciseId: string, body: object) {
  return request(ctx.app)
    .post(`/plans/exercises/${planExerciseId}/sets`)
    .set(auth(ctx.coachToken))
    .send(body);
}

function responseId(response: { body: unknown }): string {
  const id = (response.body as { id?: unknown }).id;
  if (typeof id !== 'string') throw new Error('response body is missing id');
  return id;
}

async function createDraftPlan(ctx: TestContext) {
  return ctx.db
    .insertInto('plans')
    .values({
      coach_id: ids.coach,
      trainee_id: ids.trainee,
      name: 'Intensity batch',
      start_date: '2026-08-10',
      end_date: '2026-08-16',
      plan_weeks: 1,
      source: 'coach',
      source_template_id: null,
      status: 'draft',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
}

function batchBody(set: object | object[]) {
  return {
    delete_day_ids: [],
    upsert_days: [
      {
        week_number: 1,
        day_of_week: 1,
        sort_order: 0,
        exercises: [
          {
            exercise_id: ids.exercise,
            is_main_lift: true,
            sort_order: 0,
            notes: null,
            sets: Array.isArray(set) ? set : [set],
          },
        ],
      },
    ],
  };
}

describe('spec 056 load types API', () => {
  it.each(['bodyweight', 'free_weight'])(
    'round-trips %s with no load or one intensity across create, patch and batch',
    async (load_mode) => {
      const { ctx, plan } = await makePlanContext();
      const draft = await createDraftPlan(ctx);
      const cases = [
        { input: {}, output: {} },
        { input: { target_rpe: 8.5 }, output: { target_rpe: '8.5' } },
        { input: { rir_target: 2 }, output: { rir_target: 2 } },
        { input: { target_pct: 72.5 }, output: { target_pct: '72.5' } },
      ];
      for (const [index, item] of cases.entries()) {
        const created = await createSet(ctx, plan.planExerciseId, {
          ...baseSet(index + 2),
          load_mode,
          ...item.input,
        });
        expect(created.status).toBe(201);
        expect(created.body).toMatchObject({
          ...newFieldDefaults,
          load_mode,
          ...item.output,
          intensity_mode: 'rpe',
          target_value: '10.00',
          coach_note: load_mode === 'bodyweight' ? '自重' : null,
        });
        const patched = await request(ctx.app)
          .patch(`/plans/sets/${responseId(created)}`)
          .set(auth(ctx.coachToken))
          .send({ target_reps: 8 });
        expect(patched.status).toBe(200);
        expect(patched.body).toMatchObject({ ...created.body, target_reps: 8 });
        const tree = await request(ctx.app)
          .get(`/plans/${plan.planId}`)
          .set(auth(ctx.traineeToken));
        expect(tree.status).toBe(200);
        expect(tree.body.days[0].exercises[0].sets).toContainEqual(patched.body);
      }
      const batch = await request(ctx.app)
        .post(`/plans/${draft.id}/days/batch`)
        .set(auth(ctx.coachToken))
        .send(
          batchBody(
            cases.map((item, index) => ({
              ...baseSet(index + 1),
              load_mode,
              ...item.input,
            })),
          ),
        );
      expect(batch.status).toBe(200);
      expect(batch.body.days[0].exercises[0].sets).toHaveLength(4);
      for (const set of batch.body.days[0].exercises[0].sets) {
        expect(set).toMatchObject({ load_mode, intensity_mode: 'rpe', target_value: '10.00' });
      }
    },
  );

  it.each(['bodyweight', 'free_weight'])(
    'rejects conflicting and out-of-range %s inputs on all write paths',
    async (load_mode) => {
      const { ctx, plan } = await makePlanContext();
      const draft = await createDraftPlan(ctx);
      const invalid = [
        { target_weight: 10 },
        { rpe_low: 7 },
        { rpe_high: 8 },
        { weight_low: 10 },
        { weight_high: 20 },
        { target_rpe: 8, rir_target: 2 },
        { target_rpe: 8, target_pct: 75 },
        { rir_target: 2, target_pct: 75 },
        { target_rpe: 0.5 },
        { target_rpe: 10.5 },
        { target_rpe: 8.2 },
        { rir_target: 10 },
        { rir_target: 1.5 },
        { target_pct: 19.5 },
        { target_pct: 110.5 },
        { target_pct: 72.3 },
        { pct_anchor: 'top_set' },
      ];
      for (const fields of invalid) {
        const body = { ...baseSet(2), load_mode, ...fields };
        expect((await createSet(ctx, plan.planExerciseId, body)).status).toBe(422);
        expect(
          (
            await request(ctx.app)
              .patch(`/plans/sets/${await firstSetId(ctx, plan.planExerciseId)}`)
              .set(auth(ctx.coachToken))
              .send(body)
          ).status,
        ).toBe(422);
        expect(
          (
            await request(ctx.app)
              .post(`/plans/${draft.id}/days/batch`)
              .set(auth(ctx.coachToken))
              .send(batchBody(body))
          ).status,
        ).toBe(422);
      }
    },
  );

  it('projects the complete legacy bodyweight shape and clears stale fields on mode switches', async () => {
    const { ctx, plan } = await makePlanContext();
    const id = await firstSetId(ctx, plan.planExerciseId);
    await ctx.db
      .updateTable('plan_sets')
      .set({ intensity_mode: 'rpe', target_value: '10.00', coach_note: '自重 慢下放' })
      .where('id', '=', id)
      .execute();
    const before = await request(ctx.app).get(`/plans/${plan.planId}`).set(auth(ctx.traineeToken));
    const old = before.body.days[0].exercises[0].sets[0];
    const changed = await request(ctx.app)
      .patch(`/plans/sets/${id}`)
      .set(auth(ctx.coachToken))
      .send({ load_mode: 'bodyweight', coach_note: '慢下放' });
    expect(changed.status).toBe(200);
    expect(changed.body).toEqual({ ...old, load_mode: 'bodyweight' });
    const read = await request(ctx.app).get(`/plans/${plan.planId}`).set(auth(ctx.traineeToken));
    expect(read.body.days[0].exercises[0].sets[0]).toEqual(changed.body);
    const weighted = await request(ctx.app)
      .patch(`/plans/sets/${id}`)
      .set(auth(ctx.coachToken))
      .send({ load_mode: 'pct', target_pct: 80, pct_anchor: 'top_set', target_weight: 100 });
    expect(weighted.status).toBe(200);
    const switched = await request(ctx.app)
      .patch(`/plans/sets/${id}`)
      .set(auth(ctx.coachToken))
      .send({ load_mode: 'free_weight', target_rpe: 8 });
    expect(switched.status).toBe(200);
    expect(switched.body).toMatchObject({
      load_mode: 'free_weight',
      target_weight: null,
      target_pct: null,
      pct_anchor: null,
      target_rpe: '8.0',
    });
  });
});

async function firstSetId(ctx: TestContext, exerciseId: string) {
  return (
    await ctx.db
      .selectFrom('plan_sets')
      .select('id')
      .where('plan_exercise_id', '=', exerciseId)
      .executeTakeFirstOrThrow()
  ).id;
}

describe('spec 056 legacy writes', () => {
  it.each([undefined, null])(
    'normalizes legacy create and batch with load_mode=%s and preserves response fields',
    async (load_mode) => {
      const { ctx, plan } = await makePlanContext();
      // A qualifying row must have no pre-existing non-bodyweight sibling.
      await ctx.db
        .deleteFrom('plan_sets')
        .where('plan_exercise_id', '=', plan.planExerciseId)
        .execute();
      const body = {
        ...baseSet(2),
        load_mode,
        intensity_mode: 'rpe',
        target_value: '10.00',
        coach_note: '自重 慢下放',
      };
      const created = await createSet(ctx, plan.planExerciseId, body);
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ ...body, load_mode: 'bodyweight' });
      expect(
        await ctx.db
          .selectFrom('plan_sets')
          .select(['load_mode', 'coach_note'])
          .where('id', '=', responseId(created))
          .executeTakeFirstOrThrow(),
      ).toEqual({ load_mode: 'bodyweight', coach_note: ' 慢下放' });
      const draft = await createDraftPlan(ctx);
      const batch = await request(ctx.app)
        .post(`/plans/${draft.id}/days/batch`)
        .set(auth(ctx.coachToken))
        .send(batchBody(body));
      expect(batch.status).toBe(200);
      const set = batch.body.days[0].exercises[0].sets[0];
      expect(set).toMatchObject({ ...body, load_mode: 'bodyweight' });
      expect(
        await ctx.db
          .selectFrom('plan_sets')
          .select(['load_mode', 'coach_note'])
          .where('id', '=', set.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ load_mode: 'bodyweight', coach_note: ' 慢下放' });
    },
  );

  it('normalizes merged legacy PATCH, marker-only notes and repeated old-client edits', async () => {
    const { ctx, plan } = await makePlanContext();
    const id = await firstSetId(ctx, plan.planExerciseId);
    await ctx.db
      .updateTable('plan_sets')
      .set({ intensity_mode: 'rpe', target_value: '10.00', coach_note: null })
      .where('id', '=', id)
      .execute();
    for (const body of [
      { coach_note: 'BODYWEIGHT' },
      { intensity_mode: 'rpe', target_value: 10, coach_note: '自重' },
      { target_reps: 8 },
    ]) {
      const patched = await request(ctx.app)
        .patch(`/plans/sets/${id}`)
        .set(auth(ctx.coachToken))
        .send(body);
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({
        load_mode: 'bodyweight',
        intensity_mode: 'rpe',
        target_value: '10.00',
        coach_note: '自重',
      });
      expect(
        await ctx.db
          .selectFrom('plan_sets')
          .select(['load_mode', 'coach_note'])
          .where('id', '=', id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ load_mode: 'bodyweight', coach_note: null });
    }
  });

  it('keeps ordinary legacy RPE and weight writes unchanged', async () => {
    const { ctx, plan } = await makePlanContext();
    for (const [index, body] of [
      { intensity_mode: 'rpe', target_value: 8, coach_note: '自重' },
      { intensity_mode: 'weight', target_value: 10, coach_note: '自重' },
      { intensity_mode: 'rpe', target_value: 10, coach_note: '正常备注' },
    ].entries()) {
      const created = await createSet(ctx, plan.planExerciseId, { ...baseSet(index + 2), ...body });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        ...body,
        target_value: body.target_value.toFixed(2),
        load_mode: null,
      });
    }
  });
});

describe('spec 056 legacy mode exits', () => {
  it.each([undefined, null])(
    'lets an old client replace bodyweight with ordinary weight or RPE (load_mode=%s)',
    async (load_mode) => {
      const { ctx, plan } = await makePlanContext();
      const id = await firstSetId(ctx, plan.planExerciseId);
      for (const [intensity_mode, target_value] of [
        ['weight', '50.00'],
        ['rpe', '8.00'],
      ]) {
        await ctx.db
          .updateTable('plan_sets')
          .set({
            load_mode: 'bodyweight',
            target_rpe: '7',
            intensity_mode: null,
            target_value: null,
            coach_note: null,
          })
          .where('id', '=', id)
          .execute();
        const response = await request(ctx.app)
          .patch(`/plans/sets/${id}`)
          .set(auth(ctx.coachToken))
          .send({ load_mode, intensity_mode, target_value, coach_note: null });
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
          intensity_mode,
          target_value,
          coach_note: null,
          load_mode: null,
          target_rpe: null,
        });
        const tree = await request(ctx.app)
          .get(`/plans/${plan.planId}`)
          .set(auth(ctx.traineeToken));
        expect(tree.body.days[0].exercises[0].sets[0]).toEqual(response.body);
      }
    },
  );
});

const d1Cases = [
  {
    name: 'all web markers',
    mode: 'rpe',
    value: '10.00',
    note: '自重',
    siblingMode: 'rpe',
    siblingValue: '10.00',
    siblingNote: 'BODYWEIGHT',
    converted: true,
    clean: null,
  },
  {
    name: '135 kg free-text mention',
    mode: 'weight',
    value: '135.00',
    note: '自重热身后加重',
    siblingMode: 'rpe',
    siblingValue: '10.00',
    siblingNote: '自重',
    converted: false,
    clean: '自重热身后加重',
  },
  {
    name: 'RPE 8 marker',
    mode: 'rpe',
    value: '8.00',
    note: '自重',
    siblingMode: 'rpe',
    siblingValue: '10.00',
    siblingNote: '自重',
    converted: false,
    clean: '自重',
  },
  {
    name: 'only some sets marked',
    mode: 'rpe',
    value: '10.00',
    note: '自重',
    siblingMode: 'rpe',
    siblingValue: '10.00',
    siblingNote: null,
    converted: false,
    clean: '自重',
  },
  {
    name: 'marked sibling has RPE 8',
    mode: 'rpe',
    value: '10.00',
    note: '自重',
    siblingMode: 'rpe',
    siblingValue: '8.00',
    siblingNote: '自重',
    converted: false,
    clean: '自重',
  },
  {
    name: 'marker and verbatim extra text',
    mode: 'rpe',
    value: '10.00',
    note: '自重  自重热身后加重  ',
    siblingMode: 'rpe',
    siblingValue: '10.00',
    siblingNote: '自重',
    converted: true,
    clean: '  自重热身后加重  ',
  },
  {
    name: 'RPE 10 free-text mention',
    mode: 'rpe',
    value: '10.00',
    note: '自重热身后加重',
    siblingMode: 'rpe',
    siblingValue: '10.00',
    siblingNote: '自重',
    converted: false,
    clean: '自重热身后加重',
  },
] as const;

describe('D1 legacy write row safety', () => {
  for (const path of ['create', 'PATCH', 'batch'] as const) {
    it.each(d1Cases)(`${path}: $name`, async (item) => {
      const { ctx, plan } = await makePlanContext();
      const siblingId = await firstSetId(ctx, plan.planExerciseId);
      const sibling = {
        intensity_mode: item.siblingMode,
        target_value: item.siblingValue,
        coach_note: item.siblingNote,
      };
      const incoming = {
        ...baseSet(2),
        load_mode: null,
        intensity_mode: item.mode,
        target_value: item.value,
        coach_note: item.note,
      };
      await ctx.db.updateTable('plan_sets').set(sibling).where('id', '=', siblingId).execute();
      const beforeSibling = await ctx.db
        .selectFrom('plan_sets')
        .selectAll()
        .where('id', '=', siblingId)
        .executeTakeFirstOrThrow();
      let exerciseId = plan.planExerciseId;
      if (path === 'batch') {
        const draft = await createDraftPlan(ctx);
        const response = await request(ctx.app)
          .post(`/plans/${draft.id}/days/batch`)
          .set(auth(ctx.coachToken))
          .send(batchBody([{ ...baseSet(1), ...sibling }, incoming]));
        expect(response.status).toBe(200);
        exerciseId = response.body.days[0].exercises[0].id as string;
      } else if (path === 'create') {
        expect((await createSet(ctx, exerciseId, incoming)).status).toBe(201);
      } else {
        const target = await ctx.db
          .insertInto('plan_sets')
          .values({
            plan_exercise_id: exerciseId,
            set_number: 2,
            target_reps: 5,
            intensity_mode: 'rpe',
            target_value: '10.00',
            set_type: 'working',
            coach_note: null,
            rest_seconds: null,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        const response = await request(ctx.app)
          .patch(`/plans/sets/${target.id}`)
          .set(auth(ctx.coachToken))
          .send(incoming);
        expect(response.status).toBe(200);
      }
      const rows = await ctx.db
        .selectFrom('plan_sets')
        .selectAll()
        .where('plan_exercise_id', '=', exerciseId)
        .orderBy('set_number')
        .execute();
      expect(rows.map((row) => row.load_mode)).toEqual(
        item.converted ? ['bodyweight', 'bodyweight'] : [null, null],
      );
      expect(rows[1]).toMatchObject({
        intensity_mode: item.mode,
        target_value: item.value,
        coach_note: item.clean,
      });
      if (!item.converted && path !== 'batch') expect(rows[0]).toEqual(beforeSibling);
      if (item.converted) expect(rows[0]?.coach_note).toBeNull();
    });
  }
});

describe('D1 canonical legacy roundtrip', () => {
  it.each(['bodyweight', 'free_weight'] as const)(
    'preserves a multi-set %s row on an old-client projection save',
    async (load_mode) => {
      const { ctx, plan } = await makePlanContext();
      const id = await firstSetId(ctx, plan.planExerciseId);
      const prescription = {
        load_mode,
        intensity_mode: null,
        target_value: null,
        target_rpe: '7',
        coach_note: null,
      };
      await ctx.db.updateTable('plan_sets').set(prescription).where('id', '=', id).execute();
      await ctx.db
        .insertInto('plan_sets')
        .values({
          ...baseSet(2),
          set_type: 'working',
          plan_exercise_id: plan.planExerciseId,
          ...prescription,
        })
        .execute();
      const before = await ctx.db
        .selectFrom('plan_sets')
        .selectAll()
        .where('plan_exercise_id', '=', plan.planExerciseId)
        .orderBy('set_number')
        .execute();
      const response = await request(ctx.app)
        .patch(`/plans/sets/${id}`)
        .set(auth(ctx.coachToken))
        .send({
          target_reps: 8,
          intensity_mode: 'rpe',
          target_value: '10.00',
          coach_note: load_mode === 'bodyweight' ? '自重' : null,
        });
      expect(response.status).toBe(200);
      const after = await ctx.db
        .selectFrom('plan_sets')
        .selectAll()
        .where('plan_exercise_id', '=', plan.planExerciseId)
        .orderBy('set_number')
        .execute();
      expect(after).toEqual([{ ...before[0], target_reps: 8 }, before[1]]);
    },
  );
});
