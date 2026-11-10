import { request } from './helpers/inMemoryRequest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { auth, createPublishedPlan, ids, makeContext } from './helpers/studentActions';

describe('POST /sets/log', () => {
  it('preserves null weight through create/update and negotiates legacy reads', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    const payload = {
      plan_exercise_id: plan.planExerciseId,
      set_index: 0,
      logged_date: '2026-05-15',
      weight_kg: null,
      reps: 5,
      rpe: '8',
      completed: true,
    };
    for (const weight of [null, '100', null]) {
      const saved = await request(ctx.app)
        .post('/sets/log')
        .set(auth(ctx.traineeToken))
        .send({ ...payload, weight_kg: weight });
      expect(saved.status).toBe(201);
      for (const token of [ctx.traineeToken, ctx.coachToken]) {
        for (const caps of ['', 'other-cap, set-weight-nullable']) {
          const response = await request(ctx.app)
            .get(`/students/${ids.trainee}/sets?from=2026-05-15&to=2026-05-16`)
            .set({ ...auth(token), 'X-MeetPR-Caps': caps });
          expect(response.status).toBe(200);
          expect(response.body.logs).toHaveLength(1);
          expect(response.body.logs[0].weight_kg).toBe(
            weight === null ? (caps ? null : '0') : '100.00',
          );
        }
      }
    }
  });

  it('logs a set for a published plan exercise owned by the student', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);

    const res = await request(ctx.app).post('/sets/log').set(auth(ctx.traineeToken)).send({
      plan_exercise_id: plan.planExerciseId,
      set_index: 1,
      weight_kg: '100.00',
      reps: 5,
      rpe: '8.0',
      completed: true,
    });
    const rows = await ctx.db.selectFrom('set_logs').selectAll().execute();

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(String), logged_at: expect.any(String) });
    expect(rows[0]?.failed).toBe(false);
  });

  it('requires RPE to use 0.5 steps', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    const payload = {
      plan_exercise_id: plan.planExerciseId,
      weight_kg: '100.00',
      reps: 5,
      completed: true,
    };

    for (const [setIndex, rpe] of [8.3, '8.3'].entries()) {
      const response = await request(ctx.app)
        .post('/sets/log')
        .set(auth(ctx.traineeToken))
        .send({ ...payload, set_index: setIndex, rpe });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('VALIDATION_ERROR');
    }

    for (const [setIndex, rpe] of [8.5, 10, 0].entries()) {
      const response = await request(ctx.app)
        .post('/sets/log')
        .set(auth(ctx.traineeToken))
        .send({ ...payload, set_index: setIndex + 2, rpe });

      expect(response.status).toBe(201);
    }
  });

  it('upserts by student, plan_exercise_id, and set_index and overwrites failed', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    const payload = {
      plan_exercise_id: plan.planExerciseId,
      set_index: 1,
      weight_kg: '100.00',
      reps: 5,
      rpe: null,
      completed: true,
      failed: true,
    };

    const first = await request(ctx.app)
      .post('/sets/log')
      .set(auth(ctx.traineeToken))
      .send(payload);
    const second = await request(ctx.app)
      .post('/sets/log')
      .set(auth(ctx.traineeToken))
      .send({ ...payload, weight_kg: '102.50', reps: 6, failed: false });

    const rows = await ctx.db.selectFrom('set_logs').selectAll().execute();
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.weight_kg)).toBe(102.5);
    expect(rows[0]?.reps).toBe(6);
    expect(rows[0]?.failed).toBe(false);
  });

  it('turns an assumed import into a real log on identity conflict', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await ctx.db
      .insertInto('set_logs')
      .values({
        student_id: ids.trainee,
        plan_exercise_id: plan.planExerciseId,
        exercise_id: ids.exercise,
        logged_date: '2026-05-05',
        set_index: 0,
        weight_kg: '100.00',
        reps: 5,
        rpe: null,
        completed: true,
        failed: false,
        assumed: true,
      })
      .execute();

    const response = await request(ctx.app).post('/sets/log').set(auth(ctx.traineeToken)).send({
      plan_exercise_id: plan.planExerciseId,
      set_index: 0,
      weight_kg: '105.00',
      reps: 6,
      rpe: '8.0',
      completed: true,
    });

    const row = await ctx.db.selectFrom('set_logs').selectAll().executeTakeFirstOrThrow();
    expect(response.status).toBe(201);
    expect(row.assumed).toBe(false);
    expect(Number(row.weight_kg)).toBe(105);
    expect(row.reps).toBe(6);
  });

  it('rejects coach role and unpublished or other-student plan exercises', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx, ids.coach, ids.otherStudent);
    const payload = {
      plan_exercise_id: plan.planExerciseId,
      set_index: 0,
      weight_kg: '90.00',
      reps: 5,
      completed: true,
    };

    const asCoach = await request(ctx.app)
      .post('/sets/log')
      .set(auth(ctx.coachToken))
      .send(payload);
    const wrongStudent = await request(ctx.app)
      .post('/sets/log')
      .set(auth(ctx.traineeToken))
      .send(payload);

    expect(asCoach.status).toBe(403);
    expect(wrongStudent.status).toBe(400);
    expect(wrongStudent.body).toEqual({ error: 'SETS_PLAN_EXERCISE_NOT_PUBLISHED' });
  });

  it('records a server-side user-timezone logged_date when a coached body omits it', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);

    const res = await request(ctx.app).post('/sets/log').set(auth(ctx.traineeToken)).send({
      plan_exercise_id: plan.planExerciseId,
      set_index: 2,
      weight_kg: '95.00',
      reps: 5,
      completed: true,
    });
    const rows = await ctx.db.selectFrom('set_logs').selectAll().execute();

    expect(res.status).toBe(201);
    expect(rows[0]?.logged_date).not.toBeNull();
    expect(rows[0]?.exercise_id).toBe(ids.exercise);
    expect(rows[0]?.adhoc).toBe(false);
  });

  describe('gym-day cutoff for omitted logged_date', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const payload = (planExerciseId: string) => ({
      plan_exercise_id: planExerciseId,
      set_index: 2,
      weight_kg: '95.00',
      reps: 5,
      completed: true,
    });

    it.each([
      ['GMT', '2026-01-15T20:30:00Z', '2026-01-15'],
      ['BST', '2026-07-15T20:30:00Z', '2026-07-15'],
    ])('keeps a London %s evening workout on the local date', async (_season, now, expected) => {
      const ctx = await makeContext();
      const plan = await createPublishedPlan(ctx);
      await ctx.db
        .updateTable('users')
        .set({ timezone: 'Europe/London' })
        .where('id', '=', ids.trainee)
        .execute();
      vi.useFakeTimers({ toFake: ['Date'], now: new Date(now) });

      const res = await request(ctx.app)
        .post('/sets/log')
        .set(auth(ctx.traineeToken))
        .send(payload(plan.planExerciseId));
      const row = await ctx.db.selectFrom('set_logs').select('logged_date').executeTakeFirst();

      expect(res.status).toBe(201);
      expect(dateText(row?.logged_date)).toBe(expected);
    });

    it.each([
      ['Asia/Shanghai', '2026-07-12T19:59:00Z', '2026-07-12'],
      ['Europe/London', '2026-01-13T03:59:00Z', '2026-01-12'],
      ['Europe/London', '2026-07-13T02:59:00Z', '2026-07-12'],
      ['America/New_York', '2026-07-13T07:59:00Z', '2026-07-12'],
    ])(
      'assigns a %s set logged at 03:59 to the previous training day',
      async (timezone, now, expected) => {
        const ctx = await makeContext();
        const plan = await createPublishedPlan(ctx);
        await ctx.db.updateTable('users').set({ timezone }).where('id', '=', ids.trainee).execute();
        vi.useFakeTimers({ toFake: ['Date'], now: new Date(now) });

        const res = await request(ctx.app)
          .post('/sets/log')
          .set(auth(ctx.traineeToken))
          .send(payload(plan.planExerciseId));
        const rows = await ctx.db.selectFrom('set_logs').selectAll().execute();

        expect(res.status).toBe(201);
        expect(dateText(rows[0]?.logged_date)).toBe(expected);
      },
    );

    it.each([
      ['Asia/Shanghai', '2026-07-12T20:00:00Z', '2026-07-13'],
      ['Europe/London', '2026-01-13T04:00:00Z', '2026-01-13'],
      ['Europe/London', '2026-07-13T03:00:00Z', '2026-07-13'],
      ['America/New_York', '2026-07-13T08:00:00Z', '2026-07-13'],
    ])(
      'assigns a %s set logged at 04:00 to the new training day',
      async (timezone, now, expected) => {
        const ctx = await makeContext();
        const plan = await createPublishedPlan(ctx);
        await ctx.db.updateTable('users').set({ timezone }).where('id', '=', ids.trainee).execute();
        vi.useFakeTimers({ toFake: ['Date'], now: new Date(now) });

        const res = await request(ctx.app)
          .post('/sets/log')
          .set(auth(ctx.traineeToken))
          .send(payload(plan.planExerciseId));
        const rows = await ctx.db.selectFrom('set_logs').selectAll().execute();

        expect(res.status).toBe(201);
        expect(dateText(rows[0]?.logged_date)).toBe(expected);
      },
    );
  });

  it('preserves logged_date when an old-build coached upsert edits a historical set', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    const payload = {
      plan_exercise_id: plan.planExerciseId,
      logged_date: '2026-07-01',
      set_index: 1,
      weight_kg: '100.00',
      reps: 5,
      completed: true,
    };

    await request(ctx.app).post('/sets/log').set(auth(ctx.traineeToken)).send(payload);
    // Old builds send no logged_date; the server-side "today" must not drag
    // the historical set to the current day on conflict.
    const { logged_date: _omitted, ...oldBuildPayload } = payload;
    const second = await request(ctx.app)
      .post('/sets/log')
      .set(auth(ctx.traineeToken))
      .send({ ...oldBuildPayload, weight_kg: '102.50' });

    const rows = await ctx.db.selectFrom('set_logs').selectAll().execute();
    expect(second.status).toBe(201);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.weight_kg)).toBe(102.5);
    expect(dateText(rows[0]?.logged_date)).toBe('2026-07-01');
  });

  it('updates logged_date on coached upsert when the client provides one', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    const payload = {
      plan_exercise_id: plan.planExerciseId,
      logged_date: '2026-07-01',
      set_index: 1,
      weight_kg: '100.00',
      reps: 5,
      completed: true,
    };

    await request(ctx.app).post('/sets/log').set(auth(ctx.traineeToken)).send(payload);
    const second = await request(ctx.app)
      .post('/sets/log')
      .set(auth(ctx.traineeToken))
      .send({ ...payload, logged_date: '2026-07-02' });

    const rows = await ctx.db.selectFrom('set_logs').selectAll().execute();
    expect(second.status).toBe(201);
    expect(rows).toHaveLength(1);
    expect(dateText(rows[0]?.logged_date)).toBe('2026-07-02');
  });

  it('rejects plan deletion once a linked history row exists', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    await request(ctx.app).post('/sets/log').set(auth(ctx.traineeToken)).send({
      plan_exercise_id: plan.planExerciseId,
      set_index: 1,
      weight_kg: '100.00',
      reps: 5,
      completed: true,
    });

    await expect(
      ctx.db.deleteFrom('plans').where('id', '=', plan.planId).execute(),
    ).rejects.toThrow();

    const rows = await ctx.db.selectFrom('set_logs').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.plan_exercise_id).toBe(plan.planExerciseId);
    expect(rows[0]?.exercise_id).toBe(ids.exercise);
  });
});

describe('POST /sets/log (adhoc)', () => {
  const adhocPayload = {
    exercise_id: ids.exercise,
    logged_date: '2026-07-04',
    set_index: 0,
    weight_kg: '140.00',
    reps: 5,
    rpe: '8.5',
    completed: true,
  };

  it('logs an adhoc set for a self-train student and upserts idempotently', async () => {
    const ctx = await makeContext();

    const first = await request(ctx.app)
      .post('/sets/log')
      .set(auth(ctx.selfTrainStudentToken))
      .send(adhocPayload);
    const second = await request(ctx.app)
      .post('/sets/log')
      .set(auth(ctx.selfTrainStudentToken))
      .send({ ...adhocPayload, weight_kg: '145.00', reps: 3 });

    const rows = await ctx.db.selectFrom('set_logs').selectAll().execute();
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ id: expect.any(String), logged_at: expect.any(String) });
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.weight_kg)).toBe(145);
    expect(rows[0]?.reps).toBe(3);
    expect(rows[0]?.adhoc).toBe(true);
    expect(rows[0]?.plan_exercise_id).toBeNull();
    expect(dateText(rows[0]?.logged_date)).toBe('2026-07-04');
  });

  it('allows coached students to log adhoc sets as well', async () => {
    const ctx = await makeContext();

    const res = await request(ctx.app)
      .post('/sets/log')
      .set(auth(ctx.traineeToken))
      .send(adhocPayload);

    expect(res.status).toBe(201);
  });

  it('rejects adhoc bodies that also carry plan_exercise_id', async () => {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);

    const res = await request(ctx.app)
      .post('/sets/log')
      .set(auth(ctx.selfTrainStudentToken))
      .send({ ...adhocPayload, plan_exercise_id: plan.planExerciseId });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('rejects adhoc bodies without logged_date', async () => {
    const ctx = await makeContext();
    const { logged_date: _omitted, ...withoutDate } = adhocPayload;

    const res = await request(ctx.app)
      .post('/sets/log')
      .set(auth(ctx.selfTrainStudentToken))
      .send(withoutDate);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('rejects adhoc logs for unknown exercises', async () => {
    const ctx = await makeContext();

    const res = await request(ctx.app)
      .post('/sets/log')
      .set(auth(ctx.selfTrainStudentToken))
      .send({ ...adhocPayload, exercise_id: '99999999-0000-4000-8000-000000000001' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'SETS_EXERCISE_NOT_FOUND' });
  });

  it('rejects coach role for adhoc logging', async () => {
    const ctx = await makeContext();

    const res = await request(ctx.app)
      .post('/sets/log')
      .set(auth(ctx.coachToken))
      .send(adhocPayload);

    expect(res.status).toBe(403);
  });
});

function dateText(value: unknown): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
}

it('stores null student-added weights and still permits explicit day completion', async () => {
  const ctx = await makeContext();
  const plan = await createPublishedPlan(ctx);
  const saved = await request(ctx.app).post('/sets/log').set(auth(ctx.traineeToken)).send({
    exercise_id: ids.exercise,
    plan_day_id: plan.dayId,
    logged_date: '2026-05-15',
    set_index: 0,
    weight_kg: null,
    reps: 5,
    rpe: null,
    completed: true,
  });
  expect(saved.status).toBe(201);
  const completed = await request(ctx.app)
    .post(`/plans/days/${plan.dayId}/complete`)
    .set(auth(ctx.traineeToken))
    .send({});
  expect(completed.status).toBe(200);
  for (const caps of ['', 'set-weight-nullable']) {
    const listed = await request(ctx.app)
      .get(`/students/${ids.trainee}/sets?from=2026-05-15&to=2026-05-16&scope=all`)
      .set({ ...auth(ctx.traineeToken), 'X-MeetPR-Caps': caps });
    expect(listed.body.logs[0]).toMatchObject({
      id: saved.body.id,
      adhoc: true,
      weight_kg: caps ? null : '0',
    });
  }
});

it('settles the activity ledger when the prescribed set has null weight', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-10T10:00:00Z'));
  try {
    const ctx = await makeContext();
    const plan = await createPublishedPlan(ctx);
    const saved = await request(ctx.app).post('/sets/log').set(auth(ctx.traineeToken)).send({
      plan_exercise_id: plan.planExerciseId,
      logged_date: '2026-11-10',
      set_index: 0,
      weight_kg: null,
      reps: 5,
      rpe: '8',
      completed: true,
    });
    expect(saved.status).toBe(201);
    const session = await request(ctx.app)
      .get('/students/me/session?date=2026-11-10')
      .set(auth(ctx.traineeToken));
    expect(session.status).toBe(200);
    expect(session.body.session).toMatchObject({
      status: 'completed',
      completed_at: '2026-11-10T10:00:00.000Z',
    });
    const events = await request(ctx.app)
      .get(`/coach/students/${ids.trainee}/events?from=2026-11-10&to=2026-11-10`)
      .set(auth(ctx.coachToken));
    expect(events.status).toBe(200);
    expect(events.body.events).toEqual([
      expect.objectContaining({
        event_type: 'session_completed',
        payload: expect.objectContaining({ sets_logged: 1, plan_day_ids: [plan.dayId] }),
      }),
    ]);
  } finally {
    vi.useRealTimers();
  }
});
