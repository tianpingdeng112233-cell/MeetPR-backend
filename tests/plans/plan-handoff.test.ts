import type { PlanResponse } from '../../src/routes/plans/serialization';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { request } from '../helpers/inMemoryRequest';
import {
  auth,
  createPublishedPlan,
  ids,
  makeContext,
  type TestContext,
} from '../helpers/studentActions';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await makeContext();
  await ctx.db
    .updateTable('bind_requests')
    .set({ status: 'ended' })
    .where('coach_id', '=', ids.otherCoach)
    .execute();
});
afterEach(async () => {
  await ctx.db.destroy();
});

it('returns the student current plan with progress and ordered published summaries', async () => {
  const fixture = await createPublishedPlan(ctx);
  const response = await request(ctx.app)
    .get(`/students/${ids.trainee}/plan-handoff`)
    .set(auth(ctx.traineeToken));
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    current_plan_id: fixture.planId,
    plans: [
      {
        id: fixture.planId,
        handoff_status: 'current',
        completed_training_days: 0,
        total_training_days: 1,
        status: 'published',
      },
    ],
  });
});

async function get(token = ctx.traineeToken, studentId = ids.trainee) {
  return request(ctx.app).get(`/students/${studentId}/plan-handoff`).set(auth(token));
}

it('allows the bound coach, rejects other student and unbound coach, and excludes other coaches and drafts', async () => {
  const own = await createPublishedPlan(ctx);
  await createPublishedPlan(ctx, ids.otherCoach);
  const draft = await createPublishedPlan(ctx);
  await ctx.db
    .updateTable('plans')
    .set({ status: 'draft' })
    .where('id', '=', draft.planId)
    .execute();
  expect((await get(ctx.coachToken)).body.plans.map((p: { id: string }) => p.id)).toEqual([
    own.planId,
  ]);
  expect((await get()).body.plans.map((p: { id: string }) => p.id)).toEqual([own.planId]);
  expect((await get(ctx.otherStudentToken)).status).toBe(403);
  expect((await get(ctx.otherCoachToken)).body.error).toBe('BIND_NOT_ACCEPTED');
  expect((await get(ctx.coachToken, ids.otherStudent)).status).toBe(403);
});

it('returns a deterministic empty result for no plan, only paused plans, or an ended bond', async () => {
  expect((await get()).body).toEqual({ current_plan_id: null, plans: [] });
  const p = await createPublishedPlan(ctx);
  await ctx.db.updateTable('plans').set({ status: 'paused' }).where('id', '=', p.planId).execute();
  expect((await get()).body).toEqual({ current_plan_id: null, plans: [] });
  await ctx.db
    .updateTable('plans')
    .set({ status: 'published' })
    .where('id', '=', p.planId)
    .execute();
  await ctx.db
    .updateTable('bind_requests')
    .set({ status: 'ended' })
    .where('coach_id', '=', ids.coach)
    .execute();
  expect((await get()).body).toEqual({ current_plan_id: null, plans: [] });
});

it('hands off three cycles in start order and returns after undo until the next cycle has records', async () => {
  const a = await createPublishedPlan(ctx);
  const b = await createPublishedPlan(ctx);
  const c = await createPublishedPlan(ctx);
  const start = new Date();
  for (const [index, p] of [a, b, c].entries()) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + index * 28);
    await ctx.db
      .updateTable('plans')
      .set({ start_date: d.toISOString().slice(0, 10) })
      .where('id', '=', p.planId)
      .execute();
  }
  expect((await get()).body.plans.map((p: { handoff_status: string }) => p.handoff_status)).toEqual(
    ['current', 'upcoming', 'upcoming'],
  );
  const settle = async (id: string) =>
    request(ctx.app).post(`/plans/days/${id}/complete`).set(auth(ctx.traineeToken));
  expect((await settle(a.dayId)).status).toBe(200);
  expect((await get()).body.current_plan_id).toBe(b.planId);
  expect((await settle(a.dayId)).status).toBe(200);
  expect((await get()).body.current_plan_id).toBe(b.planId);
  expect(
    (await request(ctx.app).delete(`/plans/days/${a.dayId}/complete`).set(auth(ctx.traineeToken)))
      .status,
  ).toBe(204);
  expect((await get()).body.current_plan_id).toBe(a.planId);
  await ctx.db
    .insertInto('set_logs')
    .values({
      student_id: ids.trainee,
      plan_exercise_id: b.planExerciseId,
      exercise_id: ids.exercise,
      set_index: 0,
      weight_kg: '100',
      reps: 1,
      logged_date: start.toISOString().slice(0, 10),
      logged_at: start,
    })
    .execute();
  expect((await get()).body.current_plan_id).toBe(b.planId);
  expect((await settle(b.dayId)).status).toBe(200);
  expect((await get()).body.current_plan_id).toBe(c.planId);
});

it('counts only non-rest training days and treats a partial group log as an anchor, not settlement', async () => {
  const old = await createPublishedPlan(ctx);
  await ctx.db
    .insertInto('plan_days')
    .values({ plan_id: old.planId, week_number: 1, day_of_week: 2, is_rest: true })
    .execute();
  await ctx.db
    .insertInto('set_logs')
    .values({
      student_id: ids.trainee,
      plan_exercise_id: old.planExerciseId,
      exercise_id: ids.exercise,
      set_index: 0,
      weight_kg: '100',
      reps: 1,
      completed: false,
      logged_date: new Date().toISOString().slice(0, 10),
    })
    .execute();
  const body = (await get()).body;
  expect(body.current_plan_id).toBe(old.planId);
  expect(body.plans[0]).toMatchObject({ total_training_days: 1, completed_training_days: 0 });
});

it.each(['feedback', 'three-consecutive', 'abandoned-tail', 'all-completed', 'no-plans'])(
  'serves the shared %s fixture through the HTTP contract',
  async (name) => {
    const { readFileSync } = await import('node:fs');
    type Summary = PlanResponse & {
      completed_training_days: number;
      total_training_days: number;
      handoff_status: string;
    };
    const fixture = JSON.parse(
      readFileSync(`specs/067-plan-handoff/fixtures/${name}.json`, 'utf8'),
    ) as { current_plan_id: string | null; plans: Summary[] };
    for (const [index, summary] of fixture.plans.entries()) {
      const {
        completed_training_days: done,
        total_training_days: total,
        handoff_status: _state,
        created_at,
        updated_at,
        published_at,
        tm_set_at: _tm,
        ...fields
      } = summary;
      await ctx.db
        .insertInto('plans')
        .values({
          ...fields,
          tm_set_at: null,
          created_at: new Date(created_at),
          updated_at: new Date(updated_at),
          published_at: published_at ? new Date(published_at) : null,
        })
        .execute();
      for (let n = 0; n < total; n++) {
        const day = await ctx.db
          .insertInto('plan_days')
          .values({
            plan_id: summary.id,
            week_number: Math.floor(n / 7) + 1,
            day_of_week: (n % 7) + 1,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        if (n < done)
          await ctx.db
            .insertInto('plan_day_completions')
            .values({
              plan_day_id: day.id,
              student_id: ids.trainee,
              source: 'manual',
              completed_at: new Date(Date.now() - (fixture.plans.length - index) * 86400000 + n),
            })
            .execute();
      }
    }
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.body).toEqual(fixture);
  },
);

it('SPEC 068: handoff preserves warm-up-only record presence and the student marker', async () => {
  const a = await createPublishedPlan(ctx);
  const b = await createPublishedPlan(ctx);
  await ctx.db
    .updateTable('plans')
    .set({ start_date: '2026-05-29', end_date: '2026-06-25' })
    .where('id', '=', b.planId)
    .execute();
  await ctx.db
    .insertInto('plan_day_completions')
    .values({
      plan_day_id: a.dayId,
      student_id: ids.trainee,
      source: 'manual',
      completed_at: new Date('2026-05-20T12:00:00Z'),
    })
    .execute();
  const saved = await request(ctx.app).post('/sets/log').set(auth(ctx.traineeToken)).send({
    plan_exercise_id: b.planExerciseId,
    set_index: 1,
    weight_kg: '20',
    reps: 5,
    completed: true,
    is_warmup: true,
    logged_date: '2026-05-29',
  });
  expect(saved.status).toBe(201);
  // Undoing the old cycle cannot pull the student away from records in the new one.
  await ctx.db.deleteFrom('plan_day_completions').where('plan_day_id', '=', a.dayId).execute();
  expect((await get()).body.current_plan_id).toBe(b.planId);
  const read = await request(ctx.app)
    .get(`/students/${ids.trainee}/sets?from=2026-05-29&to=2026-05-30`)
    .set(auth(ctx.traineeToken));
  expect(read.body.logs).toEqual([
    expect.objectContaining({
      id: saved.body.id,
      plan_exercise_id: b.planExerciseId,
      is_warmup: true,
    }),
  ]);
});
