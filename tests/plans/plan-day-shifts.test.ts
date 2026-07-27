import { randomUUID } from 'node:crypto';

import jwt from 'jsonwebtoken';
import type { Kysely } from 'kysely';
import { DataType, newDb } from 'pg-mem';
import pino from 'pino';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app';
import type { Config } from '../../src/config';
import { createDb } from '../../src/db/kysely';
import type { Database, PlanStatus, UserRole } from '../../src/db/types';
import { utcDateOnly } from '../../src/utils/date';

const config: Config = {
  NODE_ENV: 'test',
  PORT: 3000,
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  JWT_ACCESS_SECRET: 'access-secret-for-shift-tests-minimum-length-32',
  JWT_REFRESH_SECRET: 'refresh-secret-for-shift-tests-minimum-length-32',
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_TTL: '30d',
  LOG_LEVEL: 'silent',
  RATE_LIMIT_WINDOW_MS: 60_000,
  RATE_LIMIT_MAX: 10_000,
  EVENTS_RATE_LIMIT_WINDOW_MS: 60_000,
  EVENTS_RATE_LIMIT_MAX: 10_000,
  ANALYTICS_ENABLED: true,
  SIGNALS_CRON_ENABLED: true,
  PUSH_ENABLED: false,
  ANALYTICS_SAMPLE_RATE: 1,
  CORS_ORIGIN: '*',
  TRUST_PROXY: 0,
};

const coachId = '10000000-0000-4000-8000-000000000001';
const traineeId = '10000000-0000-4000-8000-000000000002';
const otherStudentId = '10000000-0000-4000-8000-000000000003';

interface TestContext {
  app: ReturnType<typeof createApp>;
  db: Kysely<Database>;
  coachToken: string;
  traineeToken: string;
  otherStudentToken: string;
  today: string;
  tomorrow: string;
}

function signToken(userId: string, role: UserRole): string {
  return jwt.sign({ sub: userId, role, typ: 'access' }, config.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: '15m',
    issuer: 'meetpr-api',
    audience: 'meetpr-client',
  });
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function addUtcDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function first<T>(items: T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error('Expected a seeded item');
  return item;
}

async function makeContext(): Promise<TestContext> {
  const mem = newDb();
  mem.public.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.uuid,
    impure: true,
    implementation: randomUUID,
  });
  mem.public.none(`
    CREATE TABLE users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      phone TEXT NOT NULL,
      apple_user_id TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      refresh_token_jti UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE plans (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      coach_id UUID REFERENCES users(id) ON DELETE RESTRICT,
      trainee_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      plan_weeks SMALLINT NOT NULL,
      source TEXT NOT NULL,
      source_template_id UUID,
      status TEXT NOT NULL DEFAULT 'draft',
      kind TEXT NOT NULL DEFAULT 'regular',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE plan_days (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      day_of_week SMALLINT NOT NULL,
      week_number SMALLINT NOT NULL,
      sort_order INT NOT NULL DEFAULT 0
    );

    CREATE TABLE plan_exercises (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_day_id UUID NOT NULL REFERENCES plan_days(id) ON DELETE CASCADE,
      exercise_id UUID NOT NULL,
      is_main_lift BOOLEAN NOT NULL DEFAULT FALSE,
      sort_order INT NOT NULL DEFAULT 0,
      notes TEXT
    );

    CREATE TABLE plan_sets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_exercise_id UUID NOT NULL REFERENCES plan_exercises(id) ON DELETE CASCADE,
      set_number SMALLINT NOT NULL,
      target_reps SMALLINT NOT NULL,
      target_reps_max SMALLINT,
      intensity_mode TEXT NOT NULL,
      target_value NUMERIC(6,2) NOT NULL,
      set_type TEXT NOT NULL,
      rest_seconds INT,
      coach_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE set_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_exercise_id UUID REFERENCES plan_exercises(id) ON DELETE RESTRICT,
      exercise_id UUID NOT NULL,
      set_index INT NOT NULL,
      weight_kg NUMERIC(6,2) NOT NULL,
      reps INT NOT NULL,
      rpe NUMERIC(3,1),
      completed BOOLEAN NOT NULL DEFAULT FALSE,
      failed BOOLEAN NOT NULL DEFAULT FALSE,
      assumed BOOLEAN NOT NULL DEFAULT FALSE,
      adhoc BOOLEAN NOT NULL DEFAULT FALSE,
      logged_date DATE NOT NULL,
      logged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (student_id, plan_exercise_id, set_index)
    );

    CREATE TABLE plan_day_shifts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_day_id UUID NOT NULL REFERENCES plan_days(id) ON DELETE CASCADE,
      student_id UUID NOT NULL REFERENCES users(id),
      batch_id UUID NOT NULL,
      shifted_to_date DATE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (plan_day_id, batch_id)
    );
  `);

  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  const db = createDb(pool);
  await db
    .insertInto('users')
    .values([
      { id: coachId, phone: '+8613800002001', password_hash: 'hash', role: 'coach' },
      {
        id: traineeId,
        phone: '+8613800002002',
        password_hash: 'hash',
        role: 'coached_student',
      },
      {
        id: otherStudentId,
        phone: '+8613800002003',
        password_hash: 'hash',
        role: 'coached_student',
      },
    ])
    .execute();

  const now = new Date();
  return {
    app: createApp({ config, logger: pino({ level: 'silent' }), db }),
    db,
    coachToken: signToken(coachId, 'coach'),
    traineeToken: signToken(traineeId, 'coached_student'),
    otherStudentToken: signToken(otherStudentId, 'coached_student'),
    today: utcDateOnly(now),
    tomorrow: utcDateOnly(addUtcDays(now, 1)),
  };
}

async function seedPlan(
  ctx: TestContext,
  options: { status?: PlanStatus; startOffset?: number; dayOffsets?: number[] } = {},
) {
  const startDate = utcDateOnly(addUtcDays(new Date(), options.startOffset ?? 0));
  const plan = await ctx.db
    .insertInto('plans')
    .values({
      coach_id: coachId,
      trainee_id: traineeId,
      name: 'Shiftable plan',
      start_date: startDate,
      end_date: utcDateOnly(addUtcDays(new Date(`${startDate}T00:00:00.000Z`), 6)),
      plan_weeks: 1,
      source: 'coach',
      status: options.status ?? 'published',
      kind: 'regular',
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const days = await ctx.db
    .insertInto('plan_days')
    .values(
      (options.dayOffsets ?? [0, 2, 4]).map((dayOffset) => ({
        plan_id: plan.id,
        day_of_week: dayOffset + 1,
        week_number: 1,
        sort_order: 0,
      })),
    )
    .returningAll()
    .execute();
  return { plan, days };
}

async function addLog(ctx: TestContext, dayId: string) {
  const exercise = await ctx.db
    .insertInto('plan_exercises')
    .values({
      plan_day_id: dayId,
      exercise_id: randomUUID(),
      is_main_lift: false,
      sort_order: 0,
      notes: null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await ctx.db
    .insertInto('set_logs')
    .values({
      student_id: traineeId,
      plan_exercise_id: exercise.id,
      exercise_id: exercise.exercise_id,
      set_index: 0,
      weight_kg: '100.00',
      reps: 5,
      rpe: null,
      completed: true,
      failed: false,
      assumed: false,
      logged_date: ctx.today,
    })
    .execute();
}

beforeEach(() => {
  // Fake only Date — freezing timers would hang supertest's async I/O.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-07-11T08:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('coached student whole-plan shifts', () => {
  it('shifts every remaining plan day by one day and returns one batch', async () => {
    const ctx = await makeContext();
    const { plan, days } = await seedPlan(ctx, { startOffset: -1, dayOffsets: [0, 1, 3] });

    const response = await request(ctx.app)
      .post(`/plans/${plan.id}/shift`)
      .set(auth(ctx.traineeToken));

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      batch_id: expect.any(String),
      shifted_days: [
        { day_id: days[1]?.id, shifted_to_date: ctx.tomorrow },
        { day_id: days[2]?.id, shifted_to_date: '2026-07-14' },
      ],
      total_offset_days: 1,
    });
    const rows = await ctx.db
      .selectFrom('plan_day_shifts')
      .selectAll()
      .orderBy('shifted_to_date', 'asc')
      .execute();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.batch_id))).toEqual(new Set([response.body.batch_id]));
  });

  it('stacks across UTC days from each current effective date', async () => {
    const ctx = await makeContext();
    const { plan } = await seedPlan(ctx);
    const first = await request(ctx.app)
      .post(`/plans/${plan.id}/shift`)
      .set(auth(ctx.traineeToken));

    vi.setSystemTime(new Date('2026-07-12T08:00:00.000Z'));
    const nextDayToken = signToken(traineeId, 'coached_student');
    const second = await request(ctx.app).post(`/plans/${plan.id}/shift`).set(auth(nextDayToken));

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.total_offset_days).toBe(2);
    expect(
      second.body.shifted_days.map((day: { shifted_to_date: string }) => day.shifted_to_date),
    ).toEqual(['2026-07-13', '2026-07-15', '2026-07-17']);
    const rows = await ctx.db.selectFrom('plan_day_shifts').selectAll().execute();
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((row) => row.batch_id)).size).toBe(2);
  });

  it('undoes only the latest batch and reveals the previous effective dates', async () => {
    const ctx = await makeContext();
    const { plan } = await seedPlan(ctx);
    const first = await request(ctx.app)
      .post(`/plans/${plan.id}/shift`)
      .set(auth(ctx.traineeToken));
    vi.setSystemTime(new Date('2026-07-12T08:00:00.000Z'));
    const nextDayToken = signToken(traineeId, 'coached_student');
    await request(ctx.app).post(`/plans/${plan.id}/shift`).set(auth(nextDayToken));

    const undone = await request(ctx.app).delete(`/plans/${plan.id}/shift`).set(auth(nextDayToken));

    expect(undone.status).toBe(204);
    const rows = await ctx.db.selectFrom('plan_day_shifts').selectAll().execute();
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.batch_id))).toEqual(new Set([first.body.batch_id]));
    const planResponse = await request(ctx.app).get(`/plans/${plan.id}`).set(auth(nextDayToken));
    expect(planResponse.body.total_shift_days).toBe(1);
    expect(
      planResponse.body.days.map((day: { shifted_to_date: string }) => day.shifted_to_date),
    ).toEqual(['2026-07-12', '2026-07-14', '2026-07-16']);
  });

  it('anchors the shift to an explicit target_date matching the local today', async () => {
    const ctx = await makeContext();
    const { plan, days } = await seedPlan(ctx, { startOffset: -1, dayOffsets: [0, 1, 3] });

    const response = await request(ctx.app)
      .post(`/plans/${plan.id}/shift`)
      .set(auth(ctx.traineeToken))
      .send({ target_date: ctx.today });

    expect(response.status).toBe(201);
    expect(response.body.shifted_days).toEqual([
      { day_id: days[1]?.id, shifted_to_date: ctx.tomorrow },
      { day_id: days[2]?.id, shifted_to_date: '2026-07-14' },
    ]);
  });

  it('anchors the shift a day back when the client is a calendar day behind', async () => {
    const ctx = await makeContext();
    const { plan, days } = await seedPlan(ctx, { startOffset: -1, dayOffsets: [0, 1, 3] });

    // A UTC-negative client still sees 2026-07-10 as "today"; the plan day at
    // that date anchors, and every remaining day moves with it.
    const response = await request(ctx.app)
      .post(`/plans/${plan.id}/shift`)
      .set(auth(ctx.traineeToken))
      .send({ target_date: '2026-07-10' });

    expect(response.status).toBe(201);
    expect(response.body.shifted_days).toEqual([
      { day_id: days[0]?.id, shifted_to_date: ctx.today },
      { day_id: days[1]?.id, shifted_to_date: ctx.tomorrow },
      { day_id: days[2]?.id, shifted_to_date: '2026-07-14' },
    ]);
  });

  it('rejects a target_date pointing at a rest day with SHIFT_ONLY_TODAY', async () => {
    const ctx = await makeContext();
    const { plan } = await seedPlan(ctx, { startOffset: -1, dayOffsets: [0, 1, 3] });

    // Tomorrow is inside the timezone window but holds no plan day.
    const response = await request(ctx.app)
      .post(`/plans/${plan.id}/shift`)
      .set(auth(ctx.traineeToken))
      .send({ target_date: ctx.tomorrow });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'SHIFT_ONLY_TODAY' });
  });

  it('rejects a target_date outside the one-day timezone window', async () => {
    const ctx = await makeContext();
    const { plan } = await seedPlan(ctx, { startOffset: -1, dayOffsets: [0, 1, 3] });

    const response = await request(ctx.app)
      .post(`/plans/${plan.id}/shift`)
      .set(auth(ctx.traineeToken))
      .send({ target_date: '2026-07-13' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('VALIDATION_ERROR');
    expect(response.body.issues).toEqual([
      { path: ['target_date'], message: 'target_date must be within one day of the server date' },
    ]);
  });

  it('rejects a malformed target_date and unknown body fields', async () => {
    const ctx = await makeContext();
    const { plan } = await seedPlan(ctx, { startOffset: -1, dayOffsets: [0, 1, 3] });

    const malformed = await request(ctx.app)
      .post(`/plans/${plan.id}/shift`)
      .set(auth(ctx.traineeToken))
      .send({ target_date: '2026/07/11' });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toBe('VALIDATION_ERROR');

    const unknownField = await request(ctx.app)
      .post(`/plans/${plan.id}/shift`)
      .set(auth(ctx.traineeToken))
      .send({ target_date: ctx.today, extra: true });
    expect(unknownField.status).toBe(400);
    expect(unknownField.body.error).toBe('VALIDATION_ERROR');
  });

  it('rejects a shift when UTC today is not an effective training day', async () => {
    const ctx = await makeContext();
    const { plan } = await seedPlan(ctx, { dayOffsets: [1] });

    const response = await request(ctx.app)
      .post(`/plans/${plan.id}/shift`)
      .set(auth(ctx.traineeToken));

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'SHIFT_ONLY_TODAY' });
  });

  it("rejects POST after today's course has any set log", async () => {
    const ctx = await makeContext();
    const { plan, days } = await seedPlan(ctx, { dayOffsets: [0] });
    await addLog(ctx, first(days).id);

    const response = await request(ctx.app)
      .post(`/plans/${plan.id}/shift`)
      .set(auth(ctx.traineeToken));

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'ALREADY_STARTED' });
  });

  it('rejects a student who does not own the plan from POST and DELETE', async () => {
    const ctx = await makeContext();
    const { plan } = await seedPlan(ctx, { dayOffsets: [0] });

    const posted = await request(ctx.app)
      .post(`/plans/${plan.id}/shift`)
      .set(auth(ctx.otherStudentToken));
    await request(ctx.app).post(`/plans/${plan.id}/shift`).set(auth(ctx.traineeToken));
    const deleted = await request(ctx.app)
      .delete(`/plans/${plan.id}/shift`)
      .set(auth(ctx.otherStudentToken));

    expect(posted.status).toBe(403);
    expect(posted.body).toEqual({ error: 'NOT_PLAN_STUDENT' });
    expect(deleted.status).toBe(403);
    expect(deleted.body).toEqual({ error: 'NOT_PLAN_STUDENT' });
  });

  it('rejects a draft plan as not active', async () => {
    const ctx = await makeContext();
    const { plan } = await seedPlan(ctx, { status: 'draft', dayOffsets: [0] });

    const response = await request(ctx.app)
      .post(`/plans/${plan.id}/shift`)
      .set(auth(ctx.traineeToken));

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'PLAN_NOT_ACTIVE' });
  });

  it('rejects DELETE when no shift batch exists', async () => {
    const ctx = await makeContext();
    const { plan } = await seedPlan(ctx, { dayOffsets: [0] });

    const response = await request(ctx.app)
      .delete(`/plans/${plan.id}/shift`)
      .set(auth(ctx.traineeToken));

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'NO_ACTIVE_SHIFT' });
  });

  it('rejects DELETE after the latest batch UTC creation day', async () => {
    const ctx = await makeContext();
    const { plan } = await seedPlan(ctx, { dayOffsets: [0] });
    await request(ctx.app).post(`/plans/${plan.id}/shift`).set(auth(ctx.traineeToken));
    await ctx.db
      .updateTable('plan_day_shifts')
      .set({ created_at: new Date('2026-07-10T23:59:59.000Z') })
      .execute();

    const response = await request(ctx.app)
      .delete(`/plans/${plan.id}/shift`)
      .set(auth(ctx.traineeToken));

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'UNDO_WINDOW_PASSED' });
  });

  it('rejects DELETE when the course returning to today has started', async () => {
    const ctx = await makeContext();
    const { plan, days } = await seedPlan(ctx, { dayOffsets: [0] });
    await request(ctx.app).post(`/plans/${plan.id}/shift`).set(auth(ctx.traineeToken));
    await addLog(ctx, first(days).id);

    const response = await request(ctx.app)
      .delete(`/plans/${plan.id}/shift`)
      .set(auth(ctx.traineeToken));

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'ALREADY_STARTED' });
  });

  it('serializes per-day overrides and both plan shift summary fields on detail and list GETs', async () => {
    const ctx = await makeContext();
    const { plan, days } = await seedPlan(ctx, { startOffset: -1, dayOffsets: [0, 1, 3] });
    const before = await request(ctx.app).get(`/plans/${plan.id}`).set(auth(ctx.traineeToken));
    expect(before.body.total_shift_days).toBe(0);
    expect(before.body.latest_shift_created_at).toBeNull();

    await request(ctx.app).post(`/plans/${plan.id}/shift`).set(auth(ctx.traineeToken));
    const detail = await request(ctx.app).get(`/plans/${plan.id}`).set(auth(ctx.traineeToken));
    const list = await request(ctx.app)
      .get(`/students/${traineeId}/plans`)
      .set(auth(ctx.coachToken));

    expect(detail.status).toBe(200);
    expect(detail.body.total_shift_days).toBe(1);
    expect(detail.body.latest_shift_created_at).toEqual(expect.any(String));
    expect(detail.body.days).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: days[0]?.id, shifted_to_date: null }),
        expect.objectContaining({ id: days[1]?.id, shifted_to_date: ctx.tomorrow }),
      ]),
    );
    expect(list.status).toBe(200);
    expect(list.body.plans[0]).toMatchObject({
      id: plan.id,
      total_shift_days: 1,
      latest_shift_created_at: detail.body.latest_shift_created_at,
    });
  });

  it('removes the V1 day-level shift endpoints', async () => {
    const ctx = await makeContext();
    const { days } = await seedPlan(ctx, { dayOffsets: [0] });

    const response = await request(ctx.app)
      .post(`/plans/days/${first(days).id}/shift`)
      .set(auth(ctx.traineeToken))
      .send({ shifted_to_date: ctx.tomorrow });

    expect(response.status).toBe(404);
  });
});
