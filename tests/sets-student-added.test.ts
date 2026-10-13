import { describe, expect, it } from 'vitest';

import { request } from './helpers/inMemoryRequest';
import { auth, createPublishedPlan, ids, makeContext } from './helpers/studentActions';

const payload = {
  exercise_id: ids.exercise,
  logged_date: '2026-10-13',
  set_index: 0,
  weight_kg: '60.00',
  reps: 10,
  completed: true,
};
const window = 'from=2026-10-13&to=2026-10-14&scope=all';

describe('student-added set logs', () => {
  it('writes and reads an added exercise on the student published day', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    const saved = await request(ctx.app)
      .post('/sets/log')
      .set(auth(ctx.traineeToken))
      .send({ ...payload, plan_day_id: plan.dayId });
    expect(saved.status).toBe(201);
    expect(saved.body).toEqual({ id: expect.any(String), logged_at: expect.any(String) });
    const read = await request(ctx.app)
      .get(`/students/${ids.trainee}/sets?${window}`)
      .set(auth(ctx.traineeToken));
    expect(read.status).toBe(200);
    expect(read.body.logs).toEqual([
      expect.objectContaining({ id: saved.body.id, plan_day_id: plan.dayId, adhoc: true }),
    ]);
  });
});

describe('student-added day authorization', () => {
  it.each(['other student', 'draft', 'missing'])(
    'rejects a %s day without creating a log',
    async (kind) => {
      const ctx = await makeContext();
      const plan = await createPublishedPlan(
        ctx,
        ids.coach,
        kind === 'other student' ? ids.otherStudent : ids.trainee,
      );
      if (kind === 'draft')
        await ctx.db
          .updateTable('plans')
          .set({ status: 'draft' })
          .where('id', '=', plan.planId)
          .execute();
      const saved = await request(ctx.app)
        .post('/sets/log')
        .set(auth(ctx.traineeToken))
        .send({
          ...payload,
          plan_day_id: kind === 'missing' ? '99999999-0000-4000-8000-000000000001' : plan.dayId,
        });
      expect(saved.status).toBe(400);
      expect(saved.body).toEqual({ error: 'SETS_PLAN_DAY_NOT_PUBLISHED' });
      expect(await ctx.db.selectFrom('set_logs').selectAll().execute()).toEqual([]);
    },
  );
});

describe('student-added day identity', () => {
  it.each(['day to day', 'day to null', 'null to day'])(
    'rejects %s rebinding without changing the row',
    async (kind) => {
      const ctx = await makeContext();
      const firstPlan = await createPublishedPlan(ctx);
      const secondPlan = await createPublishedPlan(ctx);
      const beforeDay = kind === 'null to day' ? {} : { plan_day_id: firstPlan.dayId };
      const afterDay = kind === 'day to null' ? {} : { plan_day_id: secondPlan.dayId };
      const first = await request(ctx.app)
        .post('/sets/log')
        .set(auth(ctx.traineeToken))
        .send({ ...payload, ...beforeDay });
      expect(first.status).toBe(201);
      const before = await ctx.db.selectFrom('set_logs').selectAll().execute();
      const second = await request(ctx.app)
        .post('/sets/log')
        .set(auth(ctx.traineeToken))
        .send({ ...payload, ...afterDay, reps: 1 });
      expect(second.status).toBe(409);
      expect(second.body).toEqual({ error: 'SETS_ADHOC_DAY_CONFLICT' });
      expect(await ctx.db.selectFrom('set_logs').selectAll().execute()).toEqual(before);
    },
  );

  it('keeps same-day replay idempotent and does not rebind racing inserts', async () => {
    const ctx = await makeContext();
    const firstPlan = await createPublishedPlan(ctx);
    const secondPlan = await createPublishedPlan(ctx);
    const results = await Promise.all(
      [firstPlan, secondPlan].map((plan) =>
        request(ctx.app)
          .post('/sets/log')
          .set(auth(ctx.traineeToken))
          .send({ ...payload, plan_day_id: plan.dayId }),
      ),
    );
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    const rows = await ctx.db.selectFrom('set_logs').selectAll().execute();
    expect(rows).toHaveLength(1);
    const replay = await request(ctx.app)
      .post('/sets/log')
      .set(auth(ctx.traineeToken))
      .send({ ...payload, plan_day_id: rows[0]?.plan_day_id?.toUpperCase(), reps: 3 });
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(rows[0]?.id);
    const read = await request(ctx.app)
      .get(`/students/${ids.trainee}/sets?${window}`)
      .set(auth(ctx.traineeToken));
    expect(read.body.logs[0]).toMatchObject({ plan_day_id: rows[0]?.plan_day_id, reps: 3 });
  });
});

describe('coach student-added scope', () => {
  it('adds only own published-plan days under all and keeps default identical to plan', async () => {
    const ctx = await makeContext();
    const own = await createPublishedPlan(ctx);
    const otherCoach = await createPublishedPlan(ctx, ids.otherCoach, ids.trainee);
    const draft = await createPublishedPlan(ctx);
    const otherStudent = await createPublishedPlan(ctx, ids.coach, ids.otherStudent);
    const planned = await request(ctx.app).post('/sets/log').set(auth(ctx.traineeToken)).send({
      plan_exercise_id: own.planExerciseId,
      logged_date: payload.logged_date,
      set_index: 1,
      weight_kg: '70.00',
      reps: 5,
      completed: true,
    });
    expect(planned.status).toBe(201);
    const addedIds: string[] = [];
    for (const [index, plan] of [own, otherCoach, draft, otherStudent].entries()) {
      const added = await request(ctx.app)
        .post('/sets/log')
        .set(auth(plan === otherStudent ? ctx.otherStudentToken : ctx.traineeToken))
        .send({ ...payload, set_index: index, plan_day_id: plan.dayId });
      expect(added.status).toBe(201);
      addedIds.push(added.body.id);
    }
    await ctx.db
      .updateTable('plans')
      .set({ status: 'draft' })
      .where('id', '=', draft.planId)
      .execute();
    await request(ctx.app)
      .post('/sets/log')
      .set(auth(ctx.traineeToken))
      .send({ ...payload, set_index: 9 });
    const path = `/students/${ids.trainee}/sets?from=2026-10-13&to=2026-10-14`;
    const legacy = await request(ctx.app).get(path).set(auth(ctx.coachToken));
    const planOnly = await request(ctx.app).get(`${path}&scope=plan`).set(auth(ctx.coachToken));
    expect(legacy.status).toBe(200);
    expect(legacy.text).toBe(planOnly.text);
    expect(legacy.body.logs).toEqual([
      expect.objectContaining({ id: planned.body.id, plan_day_id: null }),
    ]);
    const all = await request(ctx.app).get(`${path}&scope=all`).set(auth(ctx.coachToken));
    expect(all.status).toBe(200);
    expect(all.body.logs.map((row: { id: string }) => row.id).sort()).toEqual(
      [planned.body.id, addedIds[0]].sort(),
    );
    expect(all.body.logs.find((row: { id: string }) => row.id === addedIds[0])).toMatchObject({
      plan_day_id: own.dayId,
    });
    const forbidden = await request(ctx.app)
      .get(`/students/${ids.otherStudent}/sets?${window}`)
      .set(auth(ctx.otherCoachToken));
    expect(forbidden.body).toEqual({ logs: [] });
  });
});

describe('DELETE student-added logs', () => {
  it.each(['extra set', 'added exercise'])(
    'deletes an owned %s and returns 404 on replay',
    async (kind) => {
      const ctx = await makeContext();
      const plan = await createPublishedPlan(ctx);
      const body =
        kind === 'extra set'
          ? {
              plan_exercise_id: plan.planExerciseId,
              set_index: 1,
              weight_kg: '60.00',
              reps: 5,
              completed: true,
              logged_date: payload.logged_date,
            }
          : { ...payload, plan_day_id: plan.dayId };
      const saved = await request(ctx.app).post('/sets/log').set(auth(ctx.traineeToken)).send(body);
      expect(saved.status).toBe(201);
      const deleted = await request(ctx.app)
        .delete(`/sets/${String(saved.body.id)}`)
        .set(auth(ctx.traineeToken));
      expect(deleted.status).toBe(204);
      expect(deleted.text).toBe('');
      const replay = await request(ctx.app)
        .delete(`/sets/${String(saved.body.id)}`)
        .set(auth(ctx.traineeToken));
      expect(replay.status).toBe(404);
      expect(replay.body).toEqual({ error: 'SET_NOT_FOUND' });
      const read = await request(ctx.app)
        .get(`/students/${ids.trainee}/sets?${window}`)
        .set(auth(ctx.traineeToken));
      expect(read.body.logs).toEqual([]);
    },
  );
});

describe('DELETE eligibility', () => {
  it.each(['prescribed', 'assumed extra', 'pure adhoc', 'detached'])(
    'rejects %s rows unchanged',
    async (kind) => {
      const ctx = await makeContext();
      const plan = await createPublishedPlan(ctx);
      const row = await ctx.db
        .insertInto('set_logs')
        .values({
          student_id: ids.trainee,
          exercise_id: ids.exercise,
          logged_date: payload.logged_date,
          plan_exercise_id:
            kind === 'pure adhoc' || kind === 'detached' ? null : plan.planExerciseId,
          set_index: kind === 'prescribed' ? 0 : 1,
          weight_kg: '60.00',
          reps: 5,
          adhoc: kind === 'pure adhoc',
          assumed: kind === 'assumed extra',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const result = await request(ctx.app).delete(`/sets/${row.id}`).set(auth(ctx.traineeToken));
      expect(result.status).toBe(409);
      expect(result.body).toEqual({ error: 'SET_NOT_STUDENT_ADDED' });
      expect(await ctx.db.selectFrom('set_logs').selectAll().execute()).toEqual([row]);
    },
  );

  it('checks ownership before eligibility and forbids coach deletion', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    const saved = await request(ctx.app)
      .post('/sets/log')
      .set(auth(ctx.traineeToken))
      .send({ ...payload, plan_day_id: plan.dayId });
    for (const id of [saved.body.id, '99999999-0000-4000-8000-000000000001']) {
      const result = await request(ctx.app)
        .delete(`/sets/${String(id)}`)
        .set(auth(ctx.otherStudentToken));
      expect(result.status).toBe(404);
      expect(result.body).toEqual({ error: 'SET_NOT_FOUND' });
    }
    expect(
      (
        await request(ctx.app)
          .delete(`/sets/${String(saved.body.id)}`)
          .set(auth(ctx.coachToken))
      ).status,
    ).toBe(403);
    expect(await ctx.db.selectFrom('set_logs').selectAll().execute()).toHaveLength(1);
  });
});

describe('DELETE coach content protection', () => {
  it.each(['video', 'chat', 'coach rpe', 'zero coach rpe', 'prescribed with video'])(
    'protects %s with ordered errors and preserves related rows',
    async (kind) => {
      const ctx = await makeContext();
      const plan = await createPublishedPlan(ctx);
      const row = await ctx.db
        .insertInto('set_logs')
        .values({
          student_id: ids.trainee,
          exercise_id: ids.exercise,
          logged_date: payload.logged_date,
          plan_exercise_id: plan.planExerciseId,
          set_index: kind === 'prescribed with video' ? 0 : 1,
          weight_kg: '60.00',
          reps: 5,
          completed: true,
          coach_rpe: kind === 'zero coach rpe' ? '0.0' : '8.0',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      if (kind.includes('video')) {
        const video = await ctx.db
          .insertInto('attachments')
          .values({
            owner_id: ids.trainee,
            kind: 'set_video',
            oss_key: `test/${row.id}`,
            content_type: 'video/mp4',
            size_bytes: 100,
            part_count: 1,
            set_log_id: row.id,
            status: 'ready',
            coach_viewed_at: new Date(),
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await ctx.db
          .insertInto('feedback')
          .values({
            coach_id: ids.coach,
            student_id: ids.trainee,
            video_id: video.id,
            text: 'Review',
          })
          .execute();
        await ctx.db
          .insertInto('video_markers')
          .values({ video_id: video.id, coach_id: ids.coach, time_ms: 10, note: 'Review' })
          .execute();
      }
      if (kind === 'chat') {
        const conversation = await ctx.db
          .insertInto('conversations')
          .values({ coach_id: ids.coach, student_id: ids.trainee })
          .returning('id')
          .executeTakeFirstOrThrow();
        await ctx.db
          .insertInto('messages')
          .values({
            conversation_id: conversation.id,
            seq: 1,
            sender_id: ids.trainee,
            client_id: '99999999-0000-4000-8000-000000000001',
            kind: 'text',
            body: 'snapshot',
            set_ref: JSON.stringify({ v: 1, source: 'logged', set_log_id: row.id.toUpperCase() }),
          })
          .execute();
      }
      const before = {
        attachments: await ctx.db.selectFrom('attachments').selectAll().execute(),
        messages: await ctx.db.selectFrom('messages').selectAll().execute(),
        feedback: await ctx.db.selectFrom('feedback').selectAll().execute(),
        markers: await ctx.db.selectFrom('video_markers').selectAll().execute(),
      };
      const result = await request(ctx.app).delete(`/sets/${row.id}`).set(auth(ctx.traineeToken));
      expect(result.status).toBe(409);
      expect(result.body).toEqual({
        error:
          kind === 'prescribed with video'
            ? 'SET_NOT_STUDENT_ADDED'
            : kind === 'video' || kind === 'chat'
              ? 'SET_HAS_ATTACHMENT'
              : 'SET_HAS_COACH_FEEDBACK',
      });
      expect(await ctx.db.selectFrom('set_logs').selectAll().execute()).toEqual([row]);
      expect(await ctx.db.selectFrom('attachments').selectAll().execute()).toEqual(
        before.attachments,
      );
      expect(await ctx.db.selectFrom('messages').selectAll().execute()).toEqual(before.messages);
      expect(await ctx.db.selectFrom('feedback').selectAll().execute()).toEqual(before.feedback);
      expect(await ctx.db.selectFrom('video_markers').selectAll().execute()).toEqual(
        before.markers,
      );
    },
  );
});

describe('student-added deletion compatibility', () => {
  it('allows the self-train owner to delete an added exercise on their published plan', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx, ids.coach, ids.selfTrainStudent);
    const saved = await request(ctx.app)
      .post('/sets/log')
      .set(auth(ctx.selfTrainStudentToken))
      .send({ ...payload, plan_day_id: plan.dayId });
    expect(saved.status).toBe(201);
    const deleted = await request(ctx.app)
      .delete(`/sets/${String(saved.body.id)}`)
      .set(auth(ctx.selfTrainStudentToken));
    expect(deleted.status).toBe(204);
  });

  it('preserves PR event and signal snapshots like writing completed false', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await ctx.db
      .insertInto('student_onboarding_profiles')
      .values({ user_id: ids.trainee, squat_1rm_kg: '40.00' })
      .execute();
    const saved = await request(ctx.app)
      .post('/sets/log')
      .set(auth(ctx.traineeToken))
      .send({ ...payload, plan_day_id: plan.dayId });
    expect(saved.status).toBe(201);
    const events = await ctx.db
      .selectFrom('student_events')
      .selectAll()
      .where('event_type', '=', 'pr_e1rm')
      .execute();
    const signals = await ctx.db.selectFrom('student_signals').selectAll().execute();
    expect(events).toHaveLength(1);
    expect(signals).toHaveLength(1);
    const cancelled = await request(ctx.app)
      .post('/sets/log')
      .set(auth(ctx.traineeToken))
      .send({ ...payload, plan_day_id: plan.dayId, completed: false });
    expect(cancelled.status).toBe(201);
    expect(
      await ctx.db
        .selectFrom('student_events')
        .selectAll()
        .where('event_type', '=', 'pr_e1rm')
        .execute(),
    ).toEqual(events);
    const deleted = await request(ctx.app)
      .delete(`/sets/${String(saved.body.id)}`)
      .set(auth(ctx.traineeToken));
    expect(deleted.status).toBe(204);
    expect(
      await ctx.db
        .selectFrom('student_events')
        .selectAll()
        .where('event_type', '=', 'pr_e1rm')
        .execute(),
    ).toEqual(events);
    expect(await ctx.db.selectFrom('student_signals').selectAll().execute()).toEqual(signals);
  });
});
