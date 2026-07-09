import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import jwt from 'jsonwebtoken';
import type { Kysely } from 'kysely';
import { DataType, newDb } from 'pg-mem';
import pino from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

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
  dayAfterTomorrow: string;
  weekEnd: string;
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

function isoDayOfWeek(value: Date): number {
  return ((value.getUTCDay() + 6) % 7) + 1;
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
      plan_exercise_id UUID NOT NULL REFERENCES plan_exercises(id) ON DELETE RESTRICT,
      set_index INT NOT NULL,
      weight_kg NUMERIC(6,2) NOT NULL,
      reps INT NOT NULL,
      rpe NUMERIC(3,1),
      completed BOOLEAN NOT NULL DEFAULT FALSE,
      failed BOOLEAN NOT NULL DEFAULT FALSE,
      assumed BOOLEAN NOT NULL DEFAULT FALSE,
      logged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (student_id, plan_exercise_id, set_index)
    );
  `);
  mem.public.none(fs.readFileSync('db/migrations/0030-add-plan-day-shifts.sql', 'utf8'));

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
    dayAfterTomorrow: utcDateOnly(addUtcDays(now, 2)),
    weekEnd: utcDateOnly(addUtcDays(now, 6)),
  };
}

async function seedPlanDay(
  ctx: TestContext,
  options: { status?: PlanStatus; dayOffset?: number } = {},
) {
  const plan = await ctx.db
    .insertInto('plans')
    .values({
      coach_id: coachId,
      trainee_id: traineeId,
      name: 'Shiftable plan',
      start_date: ctx.today,
      end_date: ctx.weekEnd,
      plan_weeks: 1,
      source: 'coach',
      status: options.status ?? 'published',
      kind: 'regular',
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const date = addUtcDays(new Date(`${ctx.today}T00:00:00.000Z`), options.dayOffset ?? 0);
  const day = await ctx.db
    .insertInto('plan_days')
    .values({ plan_id: plan.id, day_of_week: isoDayOfWeek(date), week_number: 1, sort_order: 0 })
    .returningAll()
    .executeTakeFirstOrThrow();
  return { plan, day };
}

async function addDay(ctx: TestContext, planId: string, dayOffset: number) {
  const date = addUtcDays(new Date(`${ctx.today}T00:00:00.000Z`), dayOffset);
  return ctx.db
    .insertInto('plan_days')
    .values({ plan_id: planId, day_of_week: isoDayOfWeek(date), week_number: 1, sort_order: 0 })
    .returningAll()
    .executeTakeFirstOrThrow();
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
      set_index: 0,
      weight_kg: '100.00',
      reps: 5,
      rpe: null,
      completed: true,
      failed: false,
      assumed: false,
    })
    .execute();
}

describe('coached student plan day shifts', () => {
  it('shifts today to a rest day and lets the student revoke it', async () => {
    const ctx = await makeContext();
    const { day } = await seedPlanDay(ctx);

    const shifted = await request(ctx.app)
      .post(`/plans/days/${day.id}/shift`)
      .set(auth(ctx.traineeToken))
      .send({ shifted_to_date: ctx.tomorrow });

    expect(shifted.status).toBe(201);
    expect(shifted.body).toMatchObject({
      plan_day_id: day.id,
      shifted_to_date: ctx.tomorrow,
    });
    expect(shifted.body.id).toEqual(expect.any(String));
    expect(shifted.body.created_at).toEqual(expect.any(String));

    const revoked = await request(ctx.app)
      .delete(`/plans/days/${day.id}/shift`)
      .set(auth(ctx.traineeToken));
    expect(revoked.status).toBe(204);
    expect(await ctx.db.selectFrom('plan_day_shifts').selectAll().execute()).toEqual([]);
  });

  it('forbids another student and the coach', async () => {
    const ctx = await makeContext();
    const { day } = await seedPlanDay(ctx);

    const otherStudent = await request(ctx.app)
      .post(`/plans/days/${day.id}/shift`)
      .set(auth(ctx.otherStudentToken))
      .send({ shifted_to_date: ctx.tomorrow });
    expect(otherStudent.status).toBe(403);
    expect(otherStudent.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });

    const coach = await request(ctx.app)
      .post(`/plans/days/${day.id}/shift`)
      .set(auth(ctx.coachToken))
      .send({ shifted_to_date: ctx.tomorrow });
    expect(coach.status).toBe(403);
    expect(coach.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });
  });

  it('rejects a day whose effective date is not today', async () => {
    const ctx = await makeContext();
    const { day } = await seedPlanDay(ctx, { dayOffset: 1 });

    const response = await request(ctx.app)
      .post(`/plans/days/${day.id}/shift`)
      .set(auth(ctx.traineeToken))
      .send({ shifted_to_date: ctx.dayAfterTomorrow });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'SHIFT_ONLY_TODAY' });
  });

  it('rejects a target occupied by another derived plan day', async () => {
    const ctx = await makeContext();
    const { plan, day } = await seedPlanDay(ctx);
    await addDay(ctx, plan.id, 1);

    const response = await request(ctx.app)
      .post(`/plans/days/${day.id}/shift`)
      .set(auth(ctx.traineeToken))
      .send({ shifted_to_date: ctx.tomorrow });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'SHIFT_TARGET_NOT_REST_DAY' });
  });

  it('rejects POST and DELETE once the plan day has a set log', async () => {
    const ctx = await makeContext();
    const { day } = await seedPlanDay(ctx);
    await ctx.db
      .insertInto('plan_day_shifts')
      .values({
        plan_day_id: day.id,
        student_id: traineeId,
        shifted_to_date: ctx.tomorrow,
      })
      .execute();
    await addLog(ctx, day.id);

    const shifted = await request(ctx.app)
      .post(`/plans/days/${day.id}/shift`)
      .set(auth(ctx.traineeToken))
      .send({ shifted_to_date: ctx.tomorrow });
    expect(shifted.status).toBe(409);
    expect(shifted.body).toEqual({ error: 'SHIFT_DAY_HAS_LOGS' });

    const revoked = await request(ctx.app)
      .delete(`/plans/days/${day.id}/shift`)
      .set(auth(ctx.traineeToken));
    expect(revoked.status).toBe(409);
    expect(revoked.body).toEqual({ error: 'SHIFT_DAY_HAS_LOGS' });
  });

  it('rejects a draft plan as not active', async () => {
    const ctx = await makeContext();
    const { day } = await seedPlanDay(ctx, { status: 'draft' });

    const response = await request(ctx.app)
      .post(`/plans/days/${day.id}/shift`)
      .set(auth(ctx.traineeToken))
      .send({ shifted_to_date: ctx.tomorrow });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'PLAN_NOT_ACTIVE' });
  });

  it('serializes shifted_to_date and null on GET /plans/:id', async () => {
    const ctx = await makeContext();
    const { plan, day } = await seedPlanDay(ctx);
    const unshiftedDay = await addDay(ctx, plan.id, 2);
    await request(ctx.app)
      .post(`/plans/days/${day.id}/shift`)
      .set(auth(ctx.traineeToken))
      .send({ shifted_to_date: ctx.tomorrow });

    const response = await request(ctx.app).get(`/plans/${plan.id}`).set(auth(ctx.traineeToken));

    expect(response.status).toBe(200);
    const days = response.body.days as { id: string; shifted_to_date: string | null }[];
    expect(days.find((item) => item.id === day.id)?.shifted_to_date).toBe(ctx.tomorrow);
    expect(days.find((item) => item.id === unshiftedDay.id)?.shifted_to_date).toBeNull();
  });

  it('upserts the same target idempotently without changing identity', async () => {
    const ctx = await makeContext();
    const { day } = await seedPlanDay(ctx);
    const first = await request(ctx.app)
      .post(`/plans/days/${day.id}/shift`)
      .set(auth(ctx.traineeToken))
      .send({ shifted_to_date: ctx.tomorrow });
    const second = await request(ctx.app)
      .post(`/plans/days/${day.id}/shift`)
      .set(auth(ctx.traineeToken))
      .send({ shifted_to_date: ctx.tomorrow });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    const rows = await ctx.db.selectFrom('plan_day_shifts').selectAll().execute();
    expect(rows).toHaveLength(1);
  });
});
