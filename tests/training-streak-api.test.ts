import request from 'supertest';
import { describe, expect, it } from 'vitest';

import type { SessionStatus } from '../src/db/types';
import { shanghaiTrainingDay } from '../src/utils/date';
import { auth, ids, makeContext, type TestContext } from './helpers/studentActions';

async function insertSession(
  ctx: TestContext,
  studentId: string,
  sessionDate: string,
  status: SessionStatus,
): Promise<void> {
  const instant = new Date(`${sessionDate}T08:00:00Z`);
  await ctx.db
    .insertInto('training_sessions')
    .values({
      student_id: studentId,
      session_date: sessionDate,
      status,
      started_at: instant,
      last_set_at: instant,
      completed_at: status === 'completed' ? instant : null,
    })
    .execute();
}

describe('GET /students/me/streak', () => {
  it('returns the exact empty shape and defaults as_of to the current Shanghai gym-day', async () => {
    const ctx = await makeContext();
    const response = await request(ctx.app).get('/students/me/streak').set(auth(ctx.traineeToken));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      streak: {
        current: 0,
        as_of: shanghaiTrainingDay(),
        started_on: null,
        last_session_date: null,
      },
    });
  });

  it('uses shanghaiTrainingDay when as_of is omitted', async () => {
    const ctx = await makeContext();
    const response = await request(ctx.app)
      .get('/students/me/streak')
      .set(auth(ctx.selfTrainStudentToken));

    expect(response.status).toBe(200);
    expect(response.body.streak.as_of).toBe(shanghaiTrainingDay());
  });

  it('counts all session statuses and applies a published plan shift', async () => {
    const ctx = await makeContext();
    const planId = '30000000-0000-4000-8000-000000000101';
    const firstDayId = '31000000-0000-4000-8000-000000000101';
    const shiftedDayId = '31000000-0000-4000-8000-000000000102';
    const lastDayId = '31000000-0000-4000-8000-000000000103';

    await ctx.db
      .insertInto('plans')
      .values({
        id: planId,
        coach_id: ids.coach,
        trainee_id: ids.trainee,
        name: 'Shifted streak plan',
        start_date: '2026-07-10',
        end_date: '2026-07-23',
        plan_weeks: 2,
        source: 'coach',
        status: 'published',
      })
      .execute();
    await ctx.db
      .insertInto('plan_days')
      .values([
        {
          id: firstDayId,
          plan_id: planId,
          week_number: 1,
          day_of_week: 1,
          sort_order: 0,
        },
        {
          id: shiftedDayId,
          plan_id: planId,
          week_number: 1,
          day_of_week: 3,
          sort_order: 1,
        },
        {
          id: lastDayId,
          plan_id: planId,
          week_number: 2,
          day_of_week: 4,
          sort_order: 2,
        },
      ])
      .execute();
    await ctx.db
      .insertInto('plan_day_shifts')
      .values({
        id: '32000000-0000-4000-8000-000000000101',
        plan_day_id: shiftedDayId,
        student_id: ids.trainee,
        batch_id: '33000000-0000-4000-8000-000000000101',
        shifted_to_date: '2026-07-14',
        created_at: new Date('2026-07-11T08:00:00Z'),
      })
      .execute();

    await insertSession(ctx, ids.trainee, '2026-07-10', 'partial');
    await insertSession(ctx, ids.trainee, '2026-07-14', 'completed');
    await insertSession(ctx, ids.trainee, '2026-07-20', 'in_progress');

    const response = await request(ctx.app)
      .get('/students/me/streak?as_of=2026-07-20')
      .set(auth(ctx.traineeToken));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      streak: {
        current: 3,
        as_of: '2026-07-20',
        started_on: '2026-07-10',
        last_session_date: '2026-07-20',
      },
    });
  });

  it('allows a self-training student to read their own streak', async () => {
    const ctx = await makeContext();
    await insertSession(ctx, ids.selfTrainStudent, '2026-07-18', 'in_progress');

    const response = await request(ctx.app)
      .get('/students/me/streak?as_of=2026-07-18')
      .set(auth(ctx.selfTrainStudentToken));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      streak: {
        current: 1,
        as_of: '2026-07-18',
        started_on: '2026-07-18',
        last_session_date: '2026-07-18',
      },
    });
  });

  it('rejects coach and unauthenticated callers with the contract envelopes', async () => {
    const ctx = await makeContext();
    const asCoach = await request(ctx.app)
      .get('/students/me/streak?as_of=2026-07-18')
      .set(auth(ctx.coachToken));
    const anonymous = await request(ctx.app).get('/students/me/streak?as_of=2026-07-18');

    expect(asCoach.status).toBe(403);
    expect(asCoach.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).toEqual({ error: 'AUTH_INVALID_TOKEN' });
  });

  it('isolates each student training ledger', async () => {
    const ctx = await makeContext();
    await insertSession(ctx, ids.trainee, '2026-07-17', 'completed');
    await insertSession(ctx, ids.trainee, '2026-07-18', 'completed');
    await insertSession(ctx, ids.otherStudent, '2026-07-20', 'partial');

    const response = await request(ctx.app)
      .get('/students/me/streak?as_of=2026-07-20')
      .set(auth(ctx.otherStudentToken));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      streak: {
        current: 1,
        as_of: '2026-07-20',
        started_on: '2026-07-20',
        last_session_date: '2026-07-20',
      },
    });
  });

  it('rejects impossible dates and unknown query parameters', async () => {
    const ctx = await makeContext();
    const impossible = await request(ctx.app)
      .get('/students/me/streak?as_of=2026-02-30')
      .set(auth(ctx.traineeToken));
    const unknown = await request(ctx.app)
      .get('/students/me/streak?bogus=1')
      .set(auth(ctx.traineeToken));

    expect(impossible.status).toBe(400);
    expect(impossible.body.error).toBe('VALIDATION_ERROR');
    expect(impossible.body.issues).toEqual(expect.any(Array));
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe('VALIDATION_ERROR');
    expect(unknown.body.issues).toEqual(expect.any(Array));
  });
});
