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

describe('spec 034 plan intensity API', () => {
  it('round-trips every pct anchor through create, patch, batch, and tree reads', async () => {
    const { ctx, plan } = await makePlanContext();
    const anchors = ['one_rm', 'e1rm', 'top_set'] as const;
    const createdIds: string[] = [];
    const createProjections: { intensity_mode: unknown; target_value: unknown }[] = [];

    for (const [index, pctAnchor] of anchors.entries()) {
      const response = await createSet(ctx, plan.planExerciseId, {
        ...baseSet(index + 2),
        load_mode: 'pct',
        pct_anchor: pctAnchor,
        target_pct: '72.5',
      });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        load_mode: 'pct',
        pct_anchor: pctAnchor,
        target_pct: '72.5',
      });
      createdIds.push(responseId(response));
      createProjections.push({
        intensity_mode: response.body.intensity_mode,
        target_value: response.body.target_value,
      });
    }

    expect(createProjections).toMatchInlineSnapshot(`
      [
        {
          "intensity_mode": "rpe",
          "target_value": "7.00",
        },
        {
          "intensity_mode": "rpe",
          "target_value": "7.00",
        },
        {
          "intensity_mode": "rpe",
          "target_value": "7.00",
        },
      ]
    `);

    const patchedId = createdIds[0];
    if (patchedId === undefined) throw new Error('missing created pct set');
    for (const pctAnchor of anchors) {
      const response = await request(ctx.app)
        .patch(`/plans/sets/${patchedId}`)
        .set(auth(ctx.coachToken))
        .send({ pct_anchor: pctAnchor });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        load_mode: 'pct',
        pct_anchor: pctAnchor,
        intensity_mode: 'rpe',
        target_value: '7.00',
      });
    }

    const tree = await request(ctx.app).get(`/plans/${plan.planId}`).set(auth(ctx.traineeToken));
    expect(tree.status).toBe(200);
    const treeSets = tree.body.days[0].exercises[0].sets as {
      id: string;
      pct_anchor: string | null;
    }[];
    expect(createdIds.map((id) => treeSets.find((set) => set.id === id)?.pct_anchor)).toEqual([
      'top_set',
      'e1rm',
      'top_set',
    ]);

    const draft = await createDraftPlan(ctx);
    const batch = await request(ctx.app)
      .post(`/plans/${draft.id}/days/batch`)
      .set(auth(ctx.coachToken))
      .send(
        batchBody(
          anchors.map((pctAnchor, index) => ({
            ...baseSet(index + 1),
            load_mode: 'pct',
            pct_anchor: pctAnchor,
            target_pct: '72.5',
          })),
        ),
      );
    expect(batch.status).toBe(200);
    expect(
      (batch.body.days[0].exercises[0].sets as { pct_anchor: string | null }[]).map(
        (set) => set.pct_anchor,
      ),
    ).toEqual(anchors);
  });

  it('defaults pct anchors to null, rejects direct non-pct anchors, and clears on mode switch', async () => {
    const { ctx, plan } = await makePlanContext();
    const withoutAnchor = await createSet(ctx, plan.planExerciseId, {
      ...baseSet(2),
      load_mode: 'pct',
      target_pct: '72.5',
    });
    expect(withoutAnchor.status).toBe(201);
    expect(withoutAnchor.body.pct_anchor).toBeNull();

    const invalidCreate = await createSet(ctx, plan.planExerciseId, {
      ...baseSet(3),
      load_mode: 'rpe',
      pct_anchor: 'e1rm',
      target_rpe: '8',
    });
    expect(invalidCreate.status).toBe(422);
    expect(invalidCreate.body.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['pct_anchor'] })]),
    );

    const anchored = await createSet(ctx, plan.planExerciseId, {
      ...baseSet(4),
      load_mode: 'pct',
      pct_anchor: 'top_set',
      target_pct: '80',
    });
    const anchoredId = responseId(anchored);
    const switched = await request(ctx.app)
      .patch(`/plans/sets/${anchoredId}`)
      .set(auth(ctx.coachToken))
      .send({ load_mode: 'rpe', target_rpe: '8' });
    expect(switched.status).toBe(200);
    expect(switched.body).toMatchObject({ load_mode: 'rpe', pct_anchor: null });

    const invalidPatch = await request(ctx.app)
      .patch(`/plans/sets/${anchoredId}`)
      .set(auth(ctx.coachToken))
      .send({ pct_anchor: 'one_rm' });
    expect(invalidPatch.status).toBe(422);
    expect(invalidPatch.body.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['pct_anchor'] })]),
    );

    const draft = await createDraftPlan(ctx);
    const invalidBatch = await request(ctx.app)
      .post(`/plans/${draft.id}/days/batch`)
      .set(auth(ctx.coachToken))
      .send(
        batchBody({
          ...baseSet(1),
          load_mode: 'rir',
          pct_anchor: 'one_rm',
          rir_target: 2,
        }),
      );
    expect(invalidBatch.status).toBe(422);
    expect(invalidBatch.body.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['upsert_days', 0, 'exercises', 0, 'sets', 0, 'pct_anchor'],
        }),
      ]),
    );
  });

  it('round-trips every legal mode/weight combination with its legacy projection', async () => {
    const { ctx, plan } = await makePlanContext();
    const cases = [
      {
        input: { load_mode: 'pct', target_pct: '72.5' },
        expected: {
          load_mode: 'pct',
          target_pct: '72.5',
          intensity_mode: 'rpe',
          target_value: '7.00',
        },
      },
      {
        input: { load_mode: 'pct', target_pct: '72.5', target_weight: '170' },
        expected: {
          load_mode: 'pct',
          target_pct: '72.5',
          target_weight: '170.00',
          intensity_mode: 'weight',
          target_value: '170.00',
        },
      },
      {
        // spec 034 v2.1 sparse per-set value: intensity empty, weight carries the set
        input: { load_mode: 'pct', target_weight: '170' },
        expected: {
          load_mode: 'pct',
          target_pct: null,
          target_weight: '170.00',
          intensity_mode: 'weight',
          target_value: '170.00',
        },
      },
      {
        input: { load_mode: 'rpe', target_rpe: '8.5' },
        expected: {
          load_mode: 'rpe',
          target_rpe: '8.5',
          intensity_mode: 'rpe',
          target_value: '8.50',
        },
      },
      {
        input: { load_mode: 'rpe', target_rpe: '8', target_weight: '170' },
        expected: {
          load_mode: 'rpe',
          target_rpe: '8.0',
          target_weight: '170.00',
          intensity_mode: 'weight',
          target_value: '170.00',
        },
      },
      {
        input: { load_mode: 'rir', rir_target: '2' },
        expected: { load_mode: 'rir', rir_target: 2, intensity_mode: 'rpe', target_value: '8.00' },
      },
      {
        input: { load_mode: 'rir', rir_target: '3', target_weight: '160' },
        expected: {
          load_mode: 'rir',
          rir_target: 3,
          target_weight: '160.00',
          intensity_mode: 'weight',
          target_value: '160.00',
        },
      },
      {
        input: { load_mode: 'rpe_range', rpe_low: '7', rpe_high: '8' },
        expected: {
          load_mode: 'rpe_range',
          rpe_low: '7.0',
          rpe_high: '8.0',
          intensity_mode: 'rpe',
          target_value: '7.00',
        },
      },
      {
        input: { load_mode: 'rpe_range', rpe_low: '7.5', rpe_high: '8.5', target_weight: '165' },
        expected: {
          load_mode: 'rpe_range',
          rpe_low: '7.5',
          rpe_high: '8.5',
          target_weight: '165.00',
          intensity_mode: 'weight',
          target_value: '165.00',
        },
      },
      {
        input: { load_mode: 'weight_range', weight_low: '165', weight_high: '175' },
        expected: {
          load_mode: 'weight_range',
          weight_low: '165.00',
          weight_high: '175.00',
          intensity_mode: 'weight',
          target_value: '165.00',
        },
      },
      {
        input: { load_mode: 'fixed_weight', target_weight: '170' },
        expected: {
          load_mode: 'fixed_weight',
          target_weight: '170.00',
          intensity_mode: 'weight',
          target_value: '170.00',
        },
      },
      {
        input: { load_mode: null, target_weight: '155' },
        expected: {
          load_mode: null,
          target_weight: '155.00',
          intensity_mode: 'weight',
          target_value: '155.00',
        },
      },
    ];

    const createdIds: string[] = [];
    for (const [index, testCase] of cases.entries()) {
      const response = await createSet(ctx, plan.planExerciseId, {
        ...baseSet(index + 2),
        ...testCase.input,
        intensity_mode: 'rpe',
        target_value: '1',
      });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ ...newFieldDefaults, ...testCase.expected });
      createdIds.push(responseId(response));
    }

    const tree = await request(ctx.app).get(`/plans/${plan.planId}`).set(auth(ctx.traineeToken));
    expect(tree.status).toBe(200);
    const returnedSets = tree.body.days[0].exercises[0].sets as { id: string }[];
    for (const id of createdIds) expect(returnedSets.map((set) => set.id)).toContain(id);
  });

  it('merges PATCH final state, clears stale mode fields, and ignores forged projection fields', async () => {
    const { ctx, plan } = await makePlanContext();
    const created = await createSet(ctx, plan.planExerciseId, {
      ...baseSet(2),
      load_mode: 'rpe',
      target_rpe: '8',
      target_weight: '170',
    });
    const createdId = responseId(created);

    const switched = await request(ctx.app)
      .patch(`/plans/sets/${createdId}`)
      .set(auth(ctx.coachToken))
      .send({ load_mode: 'weight_range', weight_low: '165', weight_high: '175' });
    expect(switched.status).toBe(200);
    expect(switched.body).toMatchObject({
      load_mode: 'weight_range',
      target_rpe: null,
      target_weight: null,
      weight_low: '165.00',
      weight_high: '175.00',
      intensity_mode: 'weight',
      target_value: '165.00',
    });

    const toRpe = await request(ctx.app)
      .patch(`/plans/sets/${createdId}`)
      .set(auth(ctx.coachToken))
      .send({ load_mode: 'rpe', target_rpe: '8' });
    expect(toRpe.status).toBe(200);

    const merged = await request(ctx.app)
      .patch(`/plans/sets/${createdId}`)
      .set(auth(ctx.coachToken))
      .send({ target_rpe: '8.5', intensity_mode: 'weight', target_value: '999' });
    expect(merged.status).toBe(200);
    expect(merged.body).toMatchObject({
      load_mode: 'rpe',
      target_rpe: '8.5',
      intensity_mode: 'rpe',
      target_value: '8.50',
    });
  });

  it('returns 422 for matrix violations on create, merged patch, and batch', async () => {
    const { ctx, plan } = await makePlanContext();
    const invalidCreate = await createSet(ctx, plan.planExerciseId, {
      ...baseSet(2),
      load_mode: 'fixed_weight',
    });
    expect(invalidCreate.status).toBe(422);
    expect(invalidCreate.body.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['target_weight'] })]),
    );

    const created = await createSet(ctx, plan.planExerciseId, {
      ...baseSet(3),
      load_mode: 'rpe',
      target_rpe: '8',
    });
    const createdId = responseId(created);
    const invalidPatch = await request(ctx.app)
      .patch(`/plans/sets/${createdId}`)
      .set(auth(ctx.coachToken))
      .send({ weight_low: '100' });
    expect(invalidPatch.status).toBe(422);
    expect(invalidPatch.body.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['weight_low'] })]),
    );

    const draft = await createDraftPlan(ctx);
    const invalidBatch = await request(ctx.app)
      .post(`/plans/${draft.id}/days/batch`)
      .set(auth(ctx.coachToken))
      .send(
        batchBody({
          ...baseSet(1),
          load_mode: 'weight_range',
          weight_low: '100',
          weight_high: '110',
          target_weight: '105',
        }),
      );
    expect(invalidBatch.status).toBe(422);
    expect(invalidBatch.body.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['upsert_days', 0, 'exercises', 0, 'sets', 0, 'target_weight'],
        }),
      ]),
    );
  });

  it('returns 422 for value and step violations on create, patch, and batch', async () => {
    const { ctx, plan } = await makePlanContext();
    const invalidCreate = await createSet(ctx, plan.planExerciseId, {
      ...baseSet(2),
      load_mode: 'pct',
      target_pct: '72.3',
    });
    expect(invalidCreate.status).toBe(422);
    expect(invalidCreate.body.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['target_pct'] })]),
    );

    const created = await createSet(ctx, plan.planExerciseId, {
      ...baseSet(3),
      load_mode: 'rpe',
      target_rpe: '8',
    });
    const createdId = responseId(created);
    const invalidPatch = await request(ctx.app)
      .patch(`/plans/sets/${createdId}`)
      .set(auth(ctx.coachToken))
      .send({ target_rpe: '10.5' });
    expect(invalidPatch.status).toBe(422);
    expect(invalidPatch.body.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['target_rpe'] })]),
    );

    const draft = await createDraftPlan(ctx);
    const invalidBatch = await request(ctx.app)
      .post(`/plans/${draft.id}/days/batch`)
      .set(auth(ctx.coachToken))
      .send(batchBody({ ...baseSet(1), load_mode: 'rir', rir_target: 10 }));
    expect(invalidBatch.status).toBe(422);
    expect(invalidBatch.body.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['upsert_days', 0, 'exercises', 0, 'sets', 0, 'rir_target'],
        }),
      ]),
    );
  });

  it('writes and reads the new fields through batch', async () => {
    const ctx = await makeContext();
    await sql`ALTER TABLE plan_sets ALTER COLUMN target_value TYPE TEXT`.execute(ctx.db);
    const draft = await createDraftPlan(ctx);
    const response = await request(ctx.app)
      .post(`/plans/${draft.id}/days/batch`)
      .set(auth(ctx.coachToken))
      .send(
        batchBody({
          ...baseSet(1),
          load_mode: 'rpe_range',
          rpe_low: '7.5',
          rpe_high: '8.5',
          target_weight: '165',
        }),
      );
    expect(response.status).toBe(200);
    expect(response.body.days[0].exercises[0].sets[0]).toMatchObject({
      load_mode: 'rpe_range',
      rpe_low: '7.5',
      rpe_high: '8.5',
      target_weight: '165.00',
      intensity_mode: 'weight',
      target_value: '165.00',
    });
  });

  it('keeps legacy create/patch semantics and coalesces legacy weight only on read', async () => {
    const { ctx, plan } = await makePlanContext();
    const legacy = await createSet(ctx, plan.planExerciseId, {
      ...baseSet(2),
      intensity_mode: 'weight',
      target_value: '180.5',
    });
    const legacyId = responseId(legacy);
    expect(legacy.status).toBe(201);
    expect(legacy.body).toMatchObject({
      intensity_mode: 'weight',
      target_value: '180.50',
      ...newFieldDefaults,
      target_weight: '180.50',
    });

    const legacyTree = await request(ctx.app)
      .get(`/plans/${plan.planId}`)
      .set(auth(ctx.traineeToken));
    const legacyTreeSet = (
      legacyTree.body.days[0].exercises[0].sets as { id: string; target_weight: string | null }[]
    ).find((candidate) => candidate.id === legacyId);
    expect(legacyTreeSet?.target_weight).toBe('180.50');

    const patched = await request(ctx.app)
      .patch(`/plans/sets/${legacyId}`)
      .set(auth(ctx.coachToken))
      .send({ intensity_mode: 'rpe', target_value: '7.5' });
    expect(patched.status).toBe(200);
    expect(patched.body.intensity_mode).toBe('rpe');
    expect(patched.body.target_value).toBe('7.50');
    expect(patched.body.target_weight).toBeNull();

    const tree = await request(ctx.app).get(`/plans/${plan.planId}`).set(auth(ctx.traineeToken));
    const set = (tree.body.days[0].exercises[0].sets as { id: string }[]).find(
      (candidate) => candidate.id === legacyId,
    ) as Record<string, unknown>;
    expect({
      id: set.id,
      plan_exercise_id: set.plan_exercise_id,
      set_number: set.set_number,
      target_reps: set.target_reps,
      target_reps_max: set.target_reps_max,
      intensity_mode: set.intensity_mode,
      target_value: set.target_value,
      set_type: set.set_type,
      rest_seconds: set.rest_seconds,
      coach_note: set.coach_note,
      created_at: set.created_at,
    }).toEqual({
      id: legacyId,
      plan_exercise_id: plan.planExerciseId,
      set_number: 2,
      target_reps: 5,
      target_reps_max: null,
      intensity_mode: 'rpe',
      target_value: '7.50',
      set_type: 'working',
      rest_seconds: null,
      coach_note: null,
      created_at: expect.any(String),
    });
  });
});
