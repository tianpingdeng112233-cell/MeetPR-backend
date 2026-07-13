import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { auth, createPublishedPlan, ids, makeContext } from './helpers/studentActions';

describe('POST /sets/log', () => {
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

  it('records a server-side Shanghai logged_date when a coached body omits it', async () => {
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

    it('assigns a set logged at 03:59 Shanghai to the previous training day', async () => {
      const ctx = await makeContext();
      const plan = await createPublishedPlan(ctx);
      // 2026-07-13T03:59 Asia/Shanghai
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-07-12T19:59:00Z') });

      const res = await request(ctx.app)
        .post('/sets/log')
        .set(auth(ctx.traineeToken))
        .send(payload(plan.planExerciseId));
      const rows = await ctx.db.selectFrom('set_logs').selectAll().execute();

      expect(res.status).toBe(201);
      expect(dateText(rows[0]?.logged_date)).toBe('2026-07-12');
    });

    it('assigns a set logged at 04:00 Shanghai to the new training day', async () => {
      const ctx = await makeContext();
      const plan = await createPublishedPlan(ctx);
      // 2026-07-13T04:00 Asia/Shanghai
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-07-12T20:00:00Z') });

      const res = await request(ctx.app)
        .post('/sets/log')
        .set(auth(ctx.traineeToken))
        .send(payload(plan.planExerciseId));
      const rows = await ctx.db.selectFrom('set_logs').selectAll().execute();

      expect(res.status).toBe(201);
      expect(dateText(rows[0]?.logged_date)).toBe('2026-07-13');
    });
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
