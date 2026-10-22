import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import {
  auth,
  createPublishedPlan,
  ids,
  makeContext,
  signToken,
  type TestContext,
} from './helpers/studentActions';

const custom = {
  name: 'Tempo Squat',
  name_en: 'Original',
  exercise_type: 'main_lift_variation',
  main_lift_family: 'squat',
  is_competition_lift: false,
  muscle_groups: ['quad'],
  equipment: ['barbell'],
  movement_pattern: [],
};
const contexts: TestContext[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.db.destroy()));
});
async function fixture() {
  const ctx = await makeContext();
  contexts.push(ctx);
  const adminId = randomUUID();
  await ctx.db
    .insertInto('users')
    .values({ id: adminId, password_hash: 'hash', role: 'admin' })
    .execute();
  const admin = auth(signToken(adminId, 'admin'));
  const add = async (name = custom.name, token = ctx.coachToken) => {
    const response = await request(ctx.app)
      .post('/exercises')
      .set(auth(token))
      .send({ ...custom, name });
    expect(response.status).toBe(201);
    return response.body as { id: string };
  };
  return { ctx, admin, add };
}

describe('spec 053 admin adoption', () => {
  it('adopts into a new official and reverses links without touching historical data', async () => {
    const { ctx, admin, add } = await fixture();
    const first = await add();
    const second = await add('tempo squat', ctx.otherCoachToken);
    const plan = await createPublishedPlan(ctx);
    await ctx.db
      .updateTable('plan_exercises')
      .set({ exercise_id: first.id })
      .where('id', '=', plan.planExerciseId)
      .execute();
    await ctx.db
      .insertInto('set_logs')
      .values({
        student_id: ids.trainee,
        plan_exercise_id: plan.planExerciseId,
        exercise_id: first.id,
        set_index: 0,
        weight_kg: '100',
        reps: 5,
        logged_date: '2026-10-22',
      })
      .execute();
    const history = async () => ({
      plans: await ctx.db.selectFrom('plan_exercises').selectAll().orderBy('id').execute(),
      logs: await ctx.db.selectFrom('set_logs').selectAll().orderBy('id').execute(),
      identities: await ctx.db
        .selectFrom('exercises')
        .select(['id', 'name'])
        .where('id', 'in', [first.id, second.id])
        .orderBy('id')
        .execute(),
    });
    const before = await history();
    const adopted = await request(ctx.app)
      .post('/admin/custom-exercises/adopt')
      .set(admin)
      .send({
        exercise_ids: [first.id, second.id],
        new_official: { ...custom, name: 'Official Tempo', name_en: 'Official' },
      });
    expect(adopted.status).toBe(200);
    expect(adopted.body.official).toMatchObject({
      name: 'Official Tempo',
      created_by_coach_id: null,
    });
    expect(adopted.body.rows).toHaveLength(2);
    const officialId = adopted.body.official.id as string;
    for (const row of adopted.body.rows)
      expect(row).toMatchObject({
        canonical_exercise_id: officialId,
        adopted_at: expect.any(String),
      });
    expect(await history()).toEqual(before);
    const listing = await request(ctx.app).get('/admin/custom-exercises').set(admin);
    expect(listing.status).toBe(200);
    expect(listing.body.pending).toEqual([]);
    expect(listing.body.adopted).toEqual([
      {
        official: { id: officialId, name: 'Official Tempo', name_en: 'Official' },
        rows: expect.arrayContaining([
          expect.objectContaining({
            exercise_id: first.id,
            name: custom.name,
            coach_name: 'Coach A',
            plan_count: 1,
            adopted_at: expect.any(String),
          }),
        ]),
      },
    ]);
    const reversed = await request(ctx.app)
      .post('/admin/custom-exercises/unadopt')
      .set(admin)
      .send({ exercise_ids: [first.id, second.id] });
    expect(reversed.status).toBe(200);
    expect(await history()).toEqual(before);
    expect(
      await ctx.db
        .selectFrom('exercises')
        .select('id')
        .where('id', '=', officialId)
        .executeTakeFirst(),
    ).toBeDefined();
    const originals = await ctx.db
      .selectFrom('exercises')
      .selectAll()
      .where('id', 'in', [first.id, second.id])
      .execute();
    expect(originals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: first.id,
          name_en: 'Original',
          canonical_exercise_id: null,
          adopted_at: null,
        }),
      ]),
    );
  });

  it('groups normalized names, counts distinct plans and coaches, and orders groups by usage', async () => {
    const { ctx, admin, add } = await fixture();
    const a = await add('TEMPO   Squat');
    const b = await add('tempo squat', ctx.otherCoachToken);
    await add('Unused');
    const c = await add('Other Name');
    const p1 = await createPublishedPlan(ctx);
    const p2 = await createPublishedPlan(ctx, ids.otherCoach);
    await ctx.db
      .insertInto('plan_exercises')
      .values([
        { plan_day_id: p1.dayId, exercise_id: a.id },
        { plan_day_id: p1.dayId, exercise_id: a.id },
        { plan_day_id: p1.dayId, exercise_id: b.id },
        { plan_day_id: p2.dayId, exercise_id: b.id },
        { plan_day_id: p2.dayId, exercise_id: c.id },
      ])
      .execute();
    // Persisted legacy names can contain leading and trailing whitespace.
    await ctx.db
      .updateTable('exercises')
      .set({ name: '  TEMPO   Squat  ' })
      .where('id', '=', a.id)
      .execute();
    const response = await request(ctx.app).get('/admin/custom-exercises').set(admin);
    expect(response.status).toBe(200);
    expect(response.body.pending).toEqual([
      {
        key: 'temposquat',
        display_name: 'tempo squat',
        coach_count: 2,
        plan_count: 2,
        rows: expect.arrayContaining([
          expect.objectContaining({
            exercise_id: a.id,
            coach_id: ids.coach,
            coach_name: 'Coach A',
            plan_count: 1,
            name_en: 'Original',
            equipment: ['barbell'],
          }),
          expect.objectContaining({ exercise_id: b.id, plan_count: 2 }),
        ]),
      },
      expect.objectContaining({ key: 'othername', coach_count: 1, plan_count: 1 }),
      expect.objectContaining({ key: 'unused', plan_count: 0 }),
    ]);
    expect(response.body.adopted).toEqual([]);
  });

  it.each([
    ['保加利亚分腿蹲', '保加利亚 分腿蹲', '保加利亚\u3000分腿蹲', '保加利亚分腿蹲'],
    [
      'Tempo Squat (1)',
      'Ｔｅｍｐｏ\u3000ＳＱＵＡＴ（１）',
      'Tempo\tSquat\n\u00a0(1)',
      'temposquat(1)',
    ],
  ])(
    'groups whitespace and full-width variants of %s with distinct usage counts',
    async (aName, bName, cName, key) => {
      const { ctx, admin, add } = await fixture();
      const a = await add(aName);
      const b = await add(bName, ctx.otherCoachToken);
      const c = await add(cName);
      const p1 = await createPublishedPlan(ctx);
      const p2 = await createPublishedPlan(ctx, ids.otherCoach);
      await ctx.db
        .insertInto('plan_exercises')
        .values([
          { plan_day_id: p1.dayId, exercise_id: a.id },
          { plan_day_id: p1.dayId, exercise_id: a.id },
          { plan_day_id: p1.dayId, exercise_id: b.id },
          { plan_day_id: p2.dayId, exercise_id: b.id },
          { plan_day_id: p2.dayId, exercise_id: c.id },
        ])
        .execute();

      const response = await request(ctx.app).get('/admin/custom-exercises').set(admin);
      expect(response.status).toBe(200);
      expect(response.body.pending).toEqual([
        expect.objectContaining({
          key,
          display_name: bName,
          coach_count: 2,
          plan_count: 2,
          rows: expect.arrayContaining([
            expect.objectContaining({ exercise_id: a.id, name: aName, plan_count: 1 }),
            expect.objectContaining({ exercise_id: b.id, name: bName, plan_count: 2 }),
            expect.objectContaining({ exercise_id: c.id, name: cName, plan_count: 1 }),
          ]),
        }),
      ]);
      expect(response.body.pending[0].rows).toHaveLength(3);
      expect(response.body.adopted).toEqual([]);
    },
  );

  it('protects all three admin endpoints from non-admins', async () => {
    const { ctx } = await fixture();
    for (const token of [ctx.coachToken, ctx.traineeToken, ctx.selfTrainStudentToken]) {
      expect((await request(ctx.app).get('/admin/custom-exercises').set(auth(token))).status).toBe(
        403,
      );
      for (const action of ['adopt', 'unadopt'])
        expect(
          (
            await request(ctx.app)
              .post(`/admin/custom-exercises/${action}`)
              .set(auth(token))
              .send({ exercise_ids: [ids.exercise] })
          ).status,
        ).toBe(403);
    }
  });

  it('rejects conflicting batches atomically and requires an unlinked official target', async () => {
    const { ctx, admin, add } = await fixture();
    const a = await add();
    const b = await add('Alias B');
    const missing = randomUUID();
    const before = await ctx.db.selectFrom('exercises').selectAll().orderBy('id').execute();
    for (const conflict of [missing, ids.exercise]) {
      const response = await request(ctx.app)
        .post('/admin/custom-exercises/adopt')
        .set(admin)
        .send({ exercise_ids: [a.id, conflict], new_official: custom });
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        error: 'EXERCISE_ADOPTION_CONFLICT',
        exercise_ids: [conflict],
      });
      expect(await ctx.db.selectFrom('exercises').selectAll().orderBy('id').execute()).toEqual(
        before,
      );
    }
    for (const target of [b.id, missing])
      expect(
        (
          await request(ctx.app)
            .post('/admin/custom-exercises/adopt')
            .set(admin)
            .send({ exercise_ids: [a.id], target_exercise_id: target })
        ).status,
      ).toBe(400);
    expect(
      (
        await request(ctx.app)
          .post('/admin/custom-exercises/adopt')
          .set(admin)
          .send({ exercise_ids: [a.id], target_exercise_id: ids.exercise })
      ).status,
    ).toBe(200);
    const linked = await ctx.db.selectFrom('exercises').selectAll().orderBy('id').execute();
    expect(
      (
        await request(ctx.app)
          .post('/admin/custom-exercises/adopt')
          .set(admin)
          .send({ exercise_ids: [b.id, a.id], new_official: custom })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(ctx.app)
          .post('/admin/custom-exercises/unadopt')
          .set(admin)
          .send({ exercise_ids: [a.id, b.id] })
      ).status,
    ).toBe(409);
    expect(await ctx.db.selectFrom('exercises').selectAll().orderBy('id').execute()).toEqual(
      linked,
    );
  });

  it.each([
    { exercise_ids: [], target_exercise_id: ids.exercise },
    {
      exercise_ids: Array.from({ length: 51 }, () => randomUUID()),
      target_exercise_id: ids.exercise,
    },
    { exercise_ids: ['invalid'], target_exercise_id: ids.exercise },
    { exercise_ids: [ids.exercise] },
    { exercise_ids: [ids.exercise], target_exercise_id: ids.exercise, new_official: custom },
    { exercise_ids: [ids.exercise], new_official: { ...custom, muscle_groups: [] } },
  ])('validates adoption input %j', async (body) => {
    const { ctx, admin } = await fixture();
    const response = await request(ctx.app)
      .post('/admin/custom-exercises/adopt')
      .set(admin)
      .send(body);
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('VALIDATION_ERROR');
  });
});

describe('spec 053 catalog visibility and edit rules', () => {
  it('preserves unaffected catalogs, hides only the owning coach target, and restores attributes on unadopt', async () => {
    const { ctx, admin, add } = await fixture();
    const alias = await add();
    const plan = await createPublishedPlan(ctx);
    await ctx.db
      .updateTable('plan_exercises')
      .set({ exercise_id: alias.id })
      .where('id', '=', plan.planExerciseId)
      .execute();
    const catalog = async (token: string, query = {}) => {
      const response = await request(ctx.app).get('/exercises').query(query).set(auth(token));
      expect(response.status).toBe(200);
      return response.body.exercises as Record<string, unknown>[];
    };
    const coachBefore = await catalog(ctx.coachToken);
    const otherBefore = await catalog(ctx.otherCoachToken);
    const studentBefore = await catalog(ctx.traineeToken);
    const unrelatedBefore = await catalog(ctx.otherStudentToken);
    const original = coachBefore.find((row) => row.id === alias.id);
    expect(original).toMatchObject({
      canonical_exercise_id: null,
      adopted: false,
      name_en: 'Original',
    });
    const official = coachBefore.find((row) => row.id === ids.exercise);
    expect(official).toBeDefined();
    expect(
      (
        await request(ctx.app)
          .post('/admin/custom-exercises/adopt')
          .set(admin)
          .send({ exercise_ids: [alias.id], target_exercise_id: ids.exercise })
      ).status,
    ).toBe(200);
    const coachAfter = await catalog(ctx.coachToken);
    expect(coachAfter.some((row) => row.id === ids.exercise)).toBe(false);
    const composed = coachAfter.find((row) => row.id === alias.id);
    expect(composed).toEqual({
      ...official,
      id: alias.id,
      name: custom.name,
      created_by_coach_id: ids.coach,
      created_at: original?.created_at,
      canonical_exercise_id: ids.exercise,
      adopted: true,
    });
    expect(await catalog(ctx.otherCoachToken)).toEqual(otherBefore);
    expect(await catalog(ctx.otherStudentToken)).toEqual(unrelatedBefore);
    const studentAfter = await catalog(ctx.traineeToken);
    expect(studentAfter.map((row) => row.id).sort()).toEqual(
      studentBefore.map((row) => row.id).sort(),
    );
    expect(studentAfter.find((row) => row.id === alias.id)).toEqual(composed);
    expect(await catalog(ctx.coachToken, { exercise_type: 'main_lift' })).toEqual([composed]);
    expect(await catalog(ctx.coachToken, { exercise_type: 'main_lift_variation' })).toEqual([]);
    const locked = await request(ctx.app)
      .patch(`/exercises/${alias.id}`)
      .set(auth(ctx.coachToken))
      .send({ name_en: 'Changed' });
    expect(locked.status).toBe(409);
    expect(locked.body.error).toBe('EXERCISE_ADOPTED_ATTRIBUTES_LOCKED');
    const deleted = await request(ctx.app)
      .delete(`/exercises/${alias.id}`)
      .set(auth(ctx.coachToken));
    expect(deleted.status).toBe(409);
    expect(deleted.body.error).toBe('EXERCISE_ADOPTED');
    const unchanged = await request(ctx.app)
      .patch(`/exercises/${alias.id}`)
      .set(auth(ctx.coachToken))
      .send({
        name: custom.name,
        name_en: composed?.name_en,
        exercise_type: composed?.exercise_type,
        main_lift_family: composed?.main_lift_family,
        is_competition_lift: composed?.is_competition_lift,
        muscle_groups: composed?.muscle_groups,
        equipment: composed?.equipment,
        movement_pattern: composed?.movement_pattern,
        competition_stance: composed?.competition_stance,
      });
    expect(unchanged.status).toBe(200);
    expect(unchanged.body).toEqual(composed);
    expect(
      (
        await request(ctx.app)
          .post('/admin/custom-exercises/unadopt')
          .set(admin)
          .send({ exercise_ids: [alias.id] })
      ).status,
    ).toBe(200);
    expect(await catalog(ctx.coachToken)).toEqual(coachBefore);
    expect(await catalog(ctx.traineeToken)).toEqual(studentBefore);
  });

  it('allows renaming an adopted alias while rejecting changes to every official attribute', async () => {
    const { ctx, admin, add } = await fixture();
    const alias = await add();
    expect(
      (
        await request(ctx.app)
          .post('/admin/custom-exercises/adopt')
          .set(admin)
          .send({ exercise_ids: [alias.id], target_exercise_id: ids.exercise })
      ).status,
    ).toBe(200);
    const changes = [
      { name_en: 'Different' },
      { exercise_type: 'accessory' },
      { main_lift_family: 'bench' },
      { is_competition_lift: false },
      { competition_stance: 'high_bar' },
      { muscle_groups: ['back'] },
      { equipment: ['cable'] },
      { movement_pattern: ['horizontal_pull'] },
    ];
    for (const body of changes) {
      const response = await request(ctx.app)
        .patch(`/exercises/${alias.id}`)
        .set(auth(ctx.coachToken))
        .send(body);
      expect(response.status).toBe(409);
      expect(response.body.error).toBe('EXERCISE_ADOPTED_ATTRIBUTES_LOCKED');
    }
    const renamed = await request(ctx.app)
      .patch(`/exercises/${alias.id}`)
      .set(auth(ctx.coachToken))
      .send({ name: 'My Alias' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({
      name: 'My Alias',
      adopted: true,
      canonical_exercise_id: ids.exercise,
    });
    expect(
      (
        await request(ctx.app)
          .patch(`/exercises/${alias.id}`)
          .set(auth(ctx.otherCoachToken))
          .send({ name: 'Stolen' })
      ).status,
    ).toBe(404);
    expect(
      (await request(ctx.app).delete(`/exercises/${alias.id}`).set(auth(ctx.otherCoachToken)))
        .status,
    ).toBe(404);
  });
});

it('preserves the legacy PATCH rejection for an unadopted stance-only body', async () => {
  const { ctx, add } = await fixture();
  const alias = await add();
  const response = await request(ctx.app)
    .patch(`/exercises/${alias.id}`)
    .set(auth(ctx.coachToken))
    .send({ competition_stance: 'high_bar' });
  expect(response.status).toBe(400);
  expect(response.body.error).toBe('VALIDATION_ERROR');
});

it('accepts uppercase UUIDs for adoption and unadoption', async () => {
  const { ctx, admin, add } = await fixture();
  const alias = await add();
  const adopted = await request(ctx.app)
    .post('/admin/custom-exercises/adopt')
    .set(admin)
    .send({ exercise_ids: [alias.id.toUpperCase()], target_exercise_id: ids.exercise });
  expect(adopted.status).toBe(200);
  const reversed = await request(ctx.app)
    .post('/admin/custom-exercises/unadopt')
    .set(admin)
    .send({ exercise_ids: [alias.id.toUpperCase()] });
  expect(reversed.status).toBe(200);
  expect(reversed.body.rows).toEqual([
    expect.objectContaining({ id: alias.id, canonical_exercise_id: null, adopted: false }),
  ]);
});

it('keeps ignoring unsupported stance fields when renaming an unadopted exercise', async () => {
  const { ctx, add } = await fixture();
  const alias = await add();
  const response = await request(ctx.app)
    .patch(`/exercises/${alias.id}`)
    .set(auth(ctx.coachToken))
    .send({ name: 'Rename', competition_stance: 'unknown' });
  expect(response.status).toBe(200);
  expect(response.body.name).toBe('Rename');
});

it('breaks pending usage ties by distinct coach count and sorts adopted groups by official name', async () => {
  const { ctx, admin, add } = await fixture();
  const single = await add('A Single');
  const groupA = await add('Z Group');
  const groupDuplicate = await add('z group');
  const groupB = await add('z group', ctx.otherCoachToken);
  const pending = await request(ctx.app).get('/admin/custom-exercises').set(admin);
  expect(pending.status).toBe(200);
  expect(pending.body.pending).toEqual([
    expect.objectContaining({ key: 'zgroup', coach_count: 2, plan_count: 0 }),
    expect.objectContaining({ key: 'asingle', coach_count: 1, plan_count: 0 }),
  ]);
  for (const body of [
    { exercise_ids: [single.id], new_official: { ...custom, name: 'Z Official' } },
    {
      exercise_ids: [groupA.id, groupDuplicate.id, groupB.id],
      new_official: { ...custom, name: 'A Official' },
    },
  ])
    expect(
      (await request(ctx.app).post('/admin/custom-exercises/adopt').set(admin).send(body)).status,
    ).toBe(200);
  const adopted = await request(ctx.app).get('/admin/custom-exercises').set(admin);
  expect(adopted.status).toBe(200);
  expect(adopted.body.adopted).toEqual([
    expect.objectContaining({ official: expect.objectContaining({ name: 'A Official' }) }),
    expect.objectContaining({ official: expect.objectContaining({ name: 'Z Official' }) }),
  ]);
});

it('rejects even an official target when it already links to another exercise', async () => {
  const { ctx, admin, add } = await fixture();
  const source = await add();
  const existing = await add('Other Alias');
  const created = await request(ctx.app)
    .post('/admin/custom-exercises/adopt')
    .set(admin)
    .send({ exercise_ids: [existing.id], new_official: custom });
  expect(created.status).toBe(200);
  // Simulate a malformed imported target; handlers must never extend a chain.
  await ctx.db
    .updateTable('exercises')
    .set({ canonical_exercise_id: ids.exercise })
    .where('id', '=', created.body.official.id as string)
    .execute();
  const response = await request(ctx.app)
    .post('/admin/custom-exercises/adopt')
    .set(admin)
    .send({ exercise_ids: [source.id], target_exercise_id: created.body.official.id });
  expect(response.status).toBe(400);
  expect(response.body.error).toBe('EXERCISE_ADOPTION_INVALID_TARGET');
});
