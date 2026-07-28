import pino from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import {
  auth,
  createPublishedPlan,
  ids,
  makeContext,
  type TestContext,
} from './helpers/studentActions';

async function seedSetLog(ctx: TestContext): Promise<string> {
  const plan = await createPublishedPlan(ctx);
  const row = await ctx.db
    .insertInto('set_logs')
    .values({
      student_id: ids.trainee,
      plan_exercise_id: plan.planExerciseId,
      exercise_id: ids.exercise,
      set_index: 0,
      weight_kg: '140.00',
      reps: 5,
      rpe: '6.0',
      completed: true,
      logged_date: '2026-07-28',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

describe('PATCH /coach/set-logs/:id/coach-rpe', () => {
  it('lets a bonded coach write and clear calibration without changing student RPE', async () => {
    const logLines: string[] = [];
    const logger = pino(
      { level: 'info', base: null },
      { write: (line: string) => logLines.push(line) },
    );
    const ctx = await makeContext(logger);
    const setLogId = await seedSetLog(ctx);

    const written = await request(ctx.app)
      .patch(`/coach/set-logs/${setLogId}/coach-rpe`)
      .set(auth(ctx.coachToken))
      .send({ coach_rpe: 8.5 });

    expect(written.status).toBe(200);
    expect(written.body).toEqual({ set_log_id: setLogId, coach_rpe: '8.5' });
    const rowAfterWrite = await ctx.db
      .selectFrom('set_logs')
      .select(['rpe', 'coach_rpe'])
      .where('id', '=', setLogId)
      .executeTakeFirstOrThrow();
    expect(Number(rowAfterWrite.rpe)).toBe(6);
    expect(Number(rowAfterWrite.coach_rpe)).toBe(8.5);

    const cleared = await request(ctx.app)
      .patch(`/coach/set-logs/${setLogId}/coach-rpe`)
      .set(auth(ctx.coachToken))
      .send({ coach_rpe: null });

    expect(cleared.status).toBe(200);
    expect(cleared.body).toEqual({ set_log_id: setLogId, coach_rpe: null });
    const rowAfterClear = await ctx.db
      .selectFrom('set_logs')
      .select(['rpe', 'coach_rpe'])
      .where('id', '=', setLogId)
      .executeTakeFirstOrThrow();
    expect(Number(rowAfterClear.rpe)).toBe(6);
    expect(rowAfterClear.coach_rpe).toBeNull();

    const events = logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event.msg === 'coach_rpe_updated');
    expect(events).toEqual([
      expect.objectContaining({
        set_log_id: setLogId,
        coach_id: ids.coach,
        before: null,
        after: '8.5',
      }),
      expect.objectContaining({
        set_log_id: setLogId,
        coach_id: ids.coach,
        before: '8.5',
        after: null,
      }),
    ]);
  });

  it('returns 403 for a coach who is not bonded to the set-log student', async () => {
    const ctx = await makeContext();
    const setLogId = await seedSetLog(ctx);
    await ctx.db
      .deleteFrom('bind_requests')
      .where('coach_id', '=', ids.otherCoach)
      .where('student_id', '=', ids.trainee)
      .execute();

    const response = await request(ctx.app)
      .patch(`/coach/set-logs/${setLogId}/coach-rpe`)
      .set(auth(ctx.otherCoachToken))
      .send({ coach_rpe: 8 });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });
    expect(
      await ctx.db
        .selectFrom('set_logs')
        .select('coach_rpe')
        .where('id', '=', setLogId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ coach_rpe: null });
  });

  it('rejects values that are not on a 0.5 step', async () => {
    const ctx = await makeContext();
    const setLogId = await seedSetLog(ctx);

    const response = await request(ctx.app)
      .patch(`/coach/set-logs/${setLogId}/coach-rpe`)
      .set(auth(ctx.coachToken))
      .send({ coach_rpe: 8.3 });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('VALIDATION_ERROR');
  });

  it('rejects values outside the 0-10 range', async () => {
    const ctx = await makeContext();
    const setLogId = await seedSetLog(ctx);

    const response = await request(ctx.app)
      .patch(`/coach/set-logs/${setLogId}/coach-rpe`)
      .set(auth(ctx.coachToken))
      .send({ coach_rpe: 10.5 });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('VALIDATION_ERROR');
  });

  it('returns 403 for a set log that does not exist', async () => {
    const ctx = await makeContext();
    await seedSetLog(ctx);

    const response = await request(ctx.app)
      .patch('/coach/set-logs/00000000-0000-4000-8000-000000000000/coach-rpe')
      .set(auth(ctx.coachToken))
      .send({ coach_rpe: 8 });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });
  });
});
