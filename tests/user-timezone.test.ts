import { Writable } from 'node:stream';

import pino from 'pino';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { auth, createPublishedPlan, ids, makeContext } from './helpers/studentActions';

function dateText(value: string | Date | undefined): string | undefined {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('PATCH /me/timezone', () => {
  it('changes only future gym-day writes and emits one audit log', async () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk));
        callback();
      },
    });
    const ctx = await makeContext(pino(destination));
    const plan = await createPublishedPlan(ctx);
    await ctx.db
      .insertInto('set_logs')
      .values({
        student_id: ids.trainee,
        plan_exercise_id: plan.planExerciseId,
        exercise_id: ids.exercise,
        set_index: 0,
        weight_kg: '100.00',
        reps: 5,
        completed: true,
        failed: false,
        assumed: false,
        logged_date: '2026-07-10',
      })
      .execute();

    const changed = await request(ctx.app)
      .patch('/me/timezone')
      .set(auth(ctx.traineeToken))
      .send({ timezone: 'America/New_York' });
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-07-16T01:30:00Z') });
    const logged = await request(ctx.app).post('/sets/log').set(auth(ctx.traineeToken)).send({
      plan_exercise_id: plan.planExerciseId,
      set_index: 1,
      weight_kg: '105.00',
      reps: 5,
      completed: true,
    });

    const rows = await ctx.db
      .selectFrom('set_logs')
      .select(['set_index', 'logged_date'])
      .orderBy('set_index')
      .execute();
    expect(changed.status).toBe(204);
    expect(logged.status).toBe(201);
    expect(rows.map((row) => [row.set_index, dateText(row.logged_date)])).toEqual([
      [0, '2026-07-10'],
      [1, '2026-07-15'],
    ]);
    expect(
      lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.msg === 'user_timezone_changed'),
    ).toEqual([
      expect.objectContaining({
        userId: ids.trainee,
        previousTimezone: 'Asia/Shanghai',
        timezone: 'America/New_York',
      }),
    ]);
  });

  it('rejects an invalid timezone without changing the user row', async () => {
    const ctx = await makeContext();
    const response = await request(ctx.app)
      .patch('/me/timezone')
      .set(auth(ctx.coachToken))
      .send({ timezone: 'GMT+8' });
    const coach = await ctx.db
      .selectFrom('users')
      .select('timezone')
      .where('id', '=', ids.coach)
      .executeTakeFirstOrThrow();

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'INVALID_TIMEZONE' });
    expect(coach.timezone).toBe('Asia/Shanghai');
  });
});
