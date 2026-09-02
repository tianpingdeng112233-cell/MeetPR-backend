import { randomUUID } from 'node:crypto';

import jwt from 'jsonwebtoken';
import type { Kysely } from 'kysely';
import { DataType, newDb } from 'pg-mem';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app';
import type { Config } from '../../src/config';
import { createDb } from '../../src/db/kysely';
import type { Database, PlanStatus, UserRole } from '../../src/db/types';
import { utcDateOnly } from '../../src/utils/date';
import { request } from '../helpers/inMemoryRequest';

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
  PUSH_DAILY_DIGEST_ENABLED: false,
  ANALYTICS_SAMPLE_RATE: 1,
  CORS_ORIGIN: '*',
  TRUST_PROXY: 0,
};

const coachId = '10000000-0000-4000-8000-000000000001';
const otherCoachId = '10000000-0000-4000-8000-000000000004';
const traineeId = '10000000-0000-4000-8000-000000000002';
const otherStudentId = '10000000-0000-4000-8000-000000000003';

interface TestContext {
  app: ReturnType<typeof createApp>;
  db: Kysely<Database>;
  coachToken: string;
  otherCoachToken: string;
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

async function makeContext(configOverride: Partial<Config> = {}): Promise<TestContext> {
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
      timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
      refresh_token_jti UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE coach_profiles (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      display_name TEXT NOT NULL
    );

    CREATE TABLE student_profiles (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      display_name TEXT NOT NULL
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
      published_at TIMESTAMPTZ,
      anchor_weekday SMALLINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE plan_pending_revisions (
      plan_id UUID PRIMARY KEY REFERENCES plans(id) ON DELETE CASCADE,
      coach_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      content JSONB NOT NULL,
      saved_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
      notes TEXT,
      target TEXT
    );

    CREATE TABLE plan_day_completions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_day_id UUID NOT NULL REFERENCES plan_days(id) ON DELETE CASCADE,
      student_id UUID NOT NULL REFERENCES users(id),
      source TEXT NOT NULL CHECK (source IN ('auto', 'manual', 'backfill')),
      completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (plan_day_id)
    );

    CREATE TABLE plan_sets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_exercise_id UUID NOT NULL REFERENCES plan_exercises(id) ON DELETE CASCADE,
      set_number SMALLINT NOT NULL,
      target_reps SMALLINT NOT NULL,
      target_reps_max SMALLINT,
      intensity_mode TEXT NOT NULL,
      target_value NUMERIC(6,2) NOT NULL,
      load_mode TEXT,
      pct_anchor TEXT,
      target_pct NUMERIC(4,1),
      target_rpe NUMERIC(3,1),
      rir_target SMALLINT,
      rpe_low NUMERIC(3,1),
      rpe_high NUMERIC(3,1),
      weight_low NUMERIC(6,2),
      weight_high NUMERIC(6,2),
      target_weight NUMERIC(6,2),
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

    CREATE TABLE plan_shift_batches (
      id UUID PRIMARY KEY,
      plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      actor_id UUID NOT NULL REFERENCES users(id),
      actor_role TEXT NOT NULL CHECK (actor_role IN ('coach', 'coached_student')),
      anchor_date DATE NOT NULL,
      offset_days INTEGER NOT NULL CHECK (offset_days BETWEEN 1 AND 30),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE plan_day_shifts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      seq BIGSERIAL NOT NULL,
      plan_day_id UUID NOT NULL REFERENCES plan_days(id) ON DELETE CASCADE,
      student_id UUID NOT NULL REFERENCES users(id),
      batch_id UUID NOT NULL,
      shifted_to_date DATE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (plan_day_id, batch_id)
    );

    CREATE TABLE notification_outbox (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_type TEXT NOT NULL,
      aggregate_id UUID NOT NULL,
      recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      payload JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INT NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      delivered_at TIMESTAMPTZ,
      UNIQUE (event_type, aggregate_id, recipient_id)
    );
  `);

  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  const db = createDb(pool);
  await db
    .insertInto('users')
    .values([
      { id: coachId, phone: '+8613800002001', password_hash: 'hash', role: 'coach' },
      { id: otherCoachId, phone: '+8613800002004', password_hash: 'hash', role: 'coach' },
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
  await db
    .insertInto('coach_profiles')
    .values([
      { user_id: coachId, display_name: 'Coach A' },
      { user_id: otherCoachId, display_name: 'Coach B' },
    ])
    .execute();
  await db
    .insertInto('student_profiles')
    .values({ user_id: traineeId, display_name: '小张' })
    .execute();

  const now = new Date();
  return {
    app: createApp({
      config: { ...config, ...configOverride },
      logger: pino({ level: 'silent' }),
      db,
    }),
    db,
    coachToken: signToken(coachId, 'coach'),
    otherCoachToken: signToken(otherCoachId, 'coach'),
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

async function completeDay(ctx: TestContext, dayId: string) {
  await ctx.db
    .insertInto('plan_day_completions')
    .values({
      plan_day_id: dayId,
      student_id: traineeId,
      source: 'manual',
      completed_at: new Date('2026-07-11T07:00:00.000Z'),
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
  it('enqueues plan_shift for the plan owner after the shift commits', async () => {
    const ctx = await makeContext({ PUSH_ENABLED: true });
    const { plan } = await seedPlan(ctx);

    const response = await request(ctx.app)
      .post(`/plans/${plan.id}/shift`)
      .set(auth(ctx.traineeToken));

    expect(response.status).toBe(201);
    const row = await ctx.db
      .selectFrom('notification_outbox')
      .selectAll()
      .where('event_type', '=', 'plan_shift')
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      aggregate_id: response.body.batch_id,
      recipient_id: coachId,
      status: 'pending',
    });
    expect(row.payload).toEqual({
      student_name: '小张',
      shift_days: 1,
      student_id: traineeId,
      plan_id: plan.id,
    });
  });

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

  it('stacks across requester-local days from each current effective date', async () => {
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

  it('rejects a shift when requester-local today is not an effective training day', async () => {
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

  it.each([
    ['Asia/Shanghai', '2026-07-10T15:59:59.000Z'],
    ['Europe/London', '2026-07-10T22:59:59.000Z'],
    ['America/New_York', '2026-07-11T03:59:59.000Z'],
  ])('rejects DELETE after the latest batch %s local creation day', async (timezone, createdAt) => {
    const ctx = await makeContext();
    await ctx.db.updateTable('users').set({ timezone }).where('id', '=', traineeId).execute();
    const { plan } = await seedPlan(ctx, { dayOffsets: [0] });
    await request(ctx.app).post(`/plans/${plan.id}/shift`).set(auth(ctx.traineeToken));
    await ctx.db
      .updateTable('plan_day_shifts')
      .set({ created_at: new Date(createdAt) })
      .execute();

    const response = await request(ctx.app)
      .delete(`/plans/${plan.id}/shift`)
      .set(auth(ctx.traineeToken));

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'UNDO_WINDOW_PASSED' });
  });

  it('uses the New York calendar date across UTC midnight for shift and undo', async () => {
    vi.setSystemTime(new Date('2026-07-11T00:30:00.000Z'));
    const ctx = await makeContext();
    await ctx.db
      .updateTable('users')
      .set({ timezone: 'America/New_York' })
      .where('id', '=', traineeId)
      .execute();
    const { plan } = await seedPlan(ctx, { dayOffsets: [0] });
    await ctx.db
      .updateTable('plans')
      .set({ start_date: '2026-07-10', end_date: '2026-07-16' })
      .where('id', '=', plan.id)
      .execute();

    const shifted = await request(ctx.app)
      .post(`/plans/${plan.id}/shift`)
      .set(auth(ctx.traineeToken));
    await ctx.db
      .updateTable('plan_day_shifts')
      .set({ created_at: new Date('2026-07-10T23:59:59.000Z') })
      .execute();
    const undone = await request(ctx.app)
      .delete(`/plans/${plan.id}/shift`)
      .set(auth(ctx.traineeToken));

    expect(shifted.status).toBe(201);
    expect(shifted.body.shifted_days[0].shifted_to_date).toBe('2026-07-11');
    expect(undone.status).toBe(204);
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

describe('coach plan shifts', () => {
  it('is disabled by default without writes while the coached-student V2 path stays available', async () => {
    const ctx = await makeContext();
    const { plan } = await seedPlan(ctx, { dayOffsets: [0] });

    const invalidPost = await request(ctx.app)
      .post(`/plans/${plan.id}/shift`)
      .set(auth(ctx.coachToken))
      .send({ anchor_date: 'not-a-date', offset_days: 1 });
    const posted = await request(ctx.app)
      .post(`/plans/${plan.id}/shift`)
      .set(auth(ctx.coachToken))
      .send({ anchor_date: ctx.today, offset_days: 1 });
    const deleted = await request(ctx.app)
      .delete(`/plans/${plan.id}/shift`)
      .set(auth(ctx.coachToken));

    expect(invalidPost.status).toBe(400);
    expect(invalidPost.body.error).toBe('VALIDATION_ERROR');
    expect(posted.status).toBe(409);
    expect(posted.body).toEqual({ error: 'COACH_PLAN_SHIFT_DISABLED' });
    expect(deleted.status).toBe(409);
    expect(deleted.body).toEqual({ error: 'COACH_PLAN_SHIFT_DISABLED' });
    expect(
      await ctx.db
        .selectFrom('plan_shift_batches')
        .select(({ fn }) => fn.countAll().as('count'))
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: 0 });
    expect(
      await ctx.db
        .selectFrom('plan_day_shifts')
        .select(({ fn }) => fn.countAll().as('count'))
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: 0 });

    const studentShift = await request(ctx.app)
      .post(`/plans/${plan.id}/shift`)
      .set(auth(ctx.traineeToken));
    expect(studentShift.status).toBe(201);
    expect(studentShift.body).toMatchObject({
      shifted_days: [{ shifted_to_date: ctx.tomorrow }],
      total_offset_days: 1,
    });
  });

  it('moves all target recommended dates by three days, including beyond end_date', async () => {
    const ctx = await makeContext({ COACH_PLAN_SHIFT_ENABLED: true });
    const { plan, days } = await seedPlan(ctx, { dayOffsets: [0, 2, 6] });

    const response = await request(ctx.app)
      .post(`/plans/${plan.id}/shift`)
      .set(auth(ctx.coachToken))
      .send({ anchor_date: ctx.today, offset_days: 3 });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      batch_id: expect.any(String),
      anchor_date: ctx.today,
      offset_days: 3,
      shifted_days: [
        { day_id: days[0]?.id, shifted_to_date: '2026-07-14' },
        { day_id: days[1]?.id, shifted_to_date: '2026-07-16' },
        { day_id: days[2]?.id, shifted_to_date: '2026-07-20' },
      ],
      skipped_completed_day_ids: [],
      total_shift_days: 3,
    });
  });

  it('leaves completed days fixed and reports them as skipped', async () => {
    const ctx = await makeContext({ COACH_PLAN_SHIFT_ENABLED: true });
    const { plan, days } = await seedPlan(ctx, { dayOffsets: [0, 2] });
    await completeDay(ctx, first(days).id);

    const response = await request(ctx.app)
      .post(`/plans/${plan.id}/shift`)
      .set(auth(ctx.coachToken))
      .send({ anchor_date: ctx.today, offset_days: 2 });

    expect(response.status).toBe(201);
    expect(response.body.shifted_days).toEqual([
      { day_id: days[1]?.id, shifted_to_date: '2026-07-15' },
    ]);
    expect(response.body.skipped_completed_day_ids).toEqual([days[0]?.id]);
  });

  it('stacks from current effective dates and undo restores the previous batch', async () => {
    const ctx = await makeContext({ COACH_PLAN_SHIFT_ENABLED: true });
    const { plan } = await seedPlan(ctx, { dayOffsets: [0, 2, 4] });
    const firstShift = await request(ctx.app)
      .post(`/plans/${plan.id}/shift`)
      .set(auth(ctx.coachToken))
      .send({ anchor_date: ctx.today, offset_days: 2 });
    await ctx.db
      .updateTable('plan_shift_batches')
      .set({ created_at: new Date('2026-07-10T00:00:00.000Z') })
      .where('id', '=', firstShift.body.batch_id)
      .execute();
    await ctx.db
      .updateTable('plan_day_shifts')
      .set({ created_at: new Date('2026-07-10T00:00:00.000Z') })
      .where('batch_id', '=', firstShift.body.batch_id)
      .execute();

    const secondShift = await request(ctx.app)
      .post(`/plans/${plan.id}/shift`)
      .set(auth(ctx.coachToken))
      .send({ anchor_date: '2026-07-15', offset_days: 3 });
    expect(secondShift.status).toBe(201);
    expect(secondShift.body.total_shift_days).toBe(5);

    const stacked = await request(ctx.app).get(`/plans/${plan.id}`).set(auth(ctx.coachToken));
    expect(
      stacked.body.days.map((day: { shifted_to_date: string }) => day.shifted_to_date),
    ).toEqual(['2026-07-13', '2026-07-18', '2026-07-20']);
    expect(stacked.body.latest_shift).toMatchObject({
      batch_id: secondShift.body.batch_id,
      actor_role: 'coach',
      anchor_date: '2026-07-15',
      offset_days: 3,
    });
    expect(stacked.body.latest_shift_created_at).toBe(stacked.body.latest_shift.created_at);

    const undone = await request(ctx.app)
      .delete(`/plans/${plan.id}/shift`)
      .set(auth(ctx.coachToken));
    expect(undone.status).toBe(204);

    const restored = await request(ctx.app).get(`/plans/${plan.id}`).set(auth(ctx.coachToken));
    expect(
      restored.body.days.map((day: { shifted_to_date: string }) => day.shifted_to_date),
    ).toEqual(['2026-07-13', '2026-07-15', '2026-07-17']);
    expect(restored.body.total_shift_days).toBe(2);
    expect(restored.body.latest_shift.batch_id).toBe(firstShift.body.batch_id);
  });

  it('undoes the latest batch even when it was authored by the coached student', async () => {
    const ctx = await makeContext({ COACH_PLAN_SHIFT_ENABLED: true, PUSH_ENABLED: true });
    const { plan } = await seedPlan(ctx, { dayOffsets: [0] });
    const shifted = await request(ctx.app)
      .post(`/plans/${plan.id}/shift`)
      .set(auth(ctx.traineeToken));

    const undone = await request(ctx.app)
      .delete(`/plans/${plan.id}/shift`)
      .set(auth(ctx.coachToken));

    expect(shifted.status).toBe(201);
    expect(undone.status).toBe(204);
    const undoPush = await ctx.db
      .selectFrom('notification_outbox')
      .selectAll()
      .where('event_type', '=', 'plan_shift_undone')
      .executeTakeFirstOrThrow();
    expect(undoPush).toMatchObject({
      aggregate_id: shifted.body.batch_id,
      recipient_id: traineeId,
    });
  });

  it('refuses the coached-student undo when the latest batch belongs to the coach', async () => {
    const ctx = await makeContext({ COACH_PLAN_SHIFT_ENABLED: true });
    const { plan } = await seedPlan(ctx, { dayOffsets: [0, 2] });
    const coachShift = await request(ctx.app)
      .post(`/plans/${plan.id}/shift`)
      .set(auth(ctx.coachToken))
      .send({ anchor_date: ctx.today, offset_days: 2 });
    expect(coachShift.status).toBe(201);

    const studentUndo = await request(ctx.app)
      .delete(`/plans/${plan.id}/shift`)
      .set(auth(ctx.traineeToken));
    expect(studentUndo.status).toBe(409);
    expect(studentUndo.body).toEqual({ error: 'SHIFT_OWNED_BY_COACH' });

    const detail = await request(ctx.app).get(`/plans/${plan.id}`).set(auth(ctx.coachToken));
    expect(detail.body.latest_shift.batch_id).toBe(coachShift.body.batch_id);
    expect(
      await ctx.db
        .selectFrom('plan_day_shifts')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('batch_id', '=', coachShift.body.batch_id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: 2 });
  });

  it('undoes an old batch after the restored day has set logs', async () => {
    const ctx = await makeContext({ COACH_PLAN_SHIFT_ENABLED: true });
    const { plan, days } = await seedPlan(ctx, { dayOffsets: [0] });
    const shifted = await request(ctx.app)
      .post(`/plans/${plan.id}/shift`)
      .set(auth(ctx.coachToken))
      .send({ anchor_date: ctx.today, offset_days: 1 });
    const oldCreatedAt = new Date('2026-07-08T08:00:00.000Z');
    await ctx.db
      .updateTable('plan_shift_batches')
      .set({ created_at: oldCreatedAt })
      .where('id', '=', shifted.body.batch_id)
      .execute();
    await ctx.db
      .updateTable('plan_day_shifts')
      .set({ created_at: oldCreatedAt })
      .where('batch_id', '=', shifted.body.batch_id)
      .execute();
    await addLog(ctx, first(days).id);

    const undone = await request(ctx.app)
      .delete(`/plans/${plan.id}/shift`)
      .set(auth(ctx.coachToken));

    expect(shifted.status).toBe(201);
    expect(undone.status).toBe(204);
  });

  it('rejects coach undo when no shift batch exists', async () => {
    const ctx = await makeContext({ COACH_PLAN_SHIFT_ENABLED: true });
    const { plan } = await seedPlan(ctx, { dayOffsets: [0] });

    const response = await request(ctx.app)
      .delete(`/plans/${plan.id}/shift`)
      .set(auth(ctx.coachToken));

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'NO_ACTIVE_SHIFT' });
  });

  it('summarizes and lets a coach undo an orphaned day-level shift', async () => {
    const ctx = await makeContext({ COACH_PLAN_SHIFT_ENABLED: true });
    const { plan, days } = await seedPlan(ctx, { dayOffsets: [0] });
    const batchId = '20000000-0000-4000-8000-000000000001';
    const createdAt = new Date('2026-07-10T07:00:00.000Z');
    await ctx.db
      .insertInto('plan_day_shifts')
      .values({
        id: '21000000-0000-4000-8000-000000000001',
        plan_day_id: first(days).id,
        student_id: traineeId,
        batch_id: batchId,
        shifted_to_date: ctx.tomorrow,
        created_at: createdAt,
      })
      .execute();

    const detail = await request(ctx.app).get(`/plans/${plan.id}`).set(auth(ctx.coachToken));

    expect(detail.status).toBe(200);
    expect(detail.body.days[0].shifted_to_date).toBe(ctx.tomorrow);
    expect(detail.body).toMatchObject({
      total_shift_days: 1,
      latest_shift: {
        batch_id: batchId,
        actor_role: 'coached_student',
        anchor_date: ctx.today,
        offset_days: 1,
        created_at: createdAt.toISOString(),
      },
      latest_shift_created_at: createdAt.toISOString(),
    });

    const undone = await request(ctx.app)
      .delete(`/plans/${plan.id}/shift`)
      .set(auth(ctx.coachToken));

    expect(undone.status).toBe(204);
    expect(
      await ctx.db
        .selectFrom('plan_day_shifts')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('batch_id', '=', batchId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: 0 });
  });

  it('ignores an empty parent batch in summaries and coach undo', async () => {
    const ctx = await makeContext({ COACH_PLAN_SHIFT_ENABLED: true });
    const { plan } = await seedPlan(ctx, { dayOffsets: [0] });
    const batchId = '20000000-0000-4000-8000-000000000002';
    await ctx.db
      .insertInto('plan_shift_batches')
      .values({
        id: batchId,
        plan_id: plan.id,
        actor_id: coachId,
        actor_role: 'coach',
        anchor_date: ctx.today,
        offset_days: 1,
      })
      .execute();

    const detail = await request(ctx.app).get(`/plans/${plan.id}`).set(auth(ctx.coachToken));
    const undone = await request(ctx.app)
      .delete(`/plans/${plan.id}/shift`)
      .set(auth(ctx.coachToken));

    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      total_shift_days: 0,
      latest_shift: null,
      latest_shift_created_at: null,
    });
    expect(undone.status).toBe(409);
    expect(undone.body).toEqual({ error: 'NO_ACTIVE_SHIFT' });
  });

  it('uses the day-level seq key for detail dates, summaries, and coach undo', async () => {
    const ctx = await makeContext({ COACH_PLAN_SHIFT_ENABLED: true });
    const { plan, days } = await seedPlan(ctx, { dayOffsets: [0] });
    const previousBatchId = '22000000-0000-4000-8000-000000000001';
    const latestBatchId = '22000000-0000-4000-8000-000000000002';
    const tiedCreatedAt = new Date('2026-07-10T07:00:00.000Z');
    await ctx.db
      .insertInto('plan_shift_batches')
      .values([
        {
          id: previousBatchId,
          plan_id: plan.id,
          actor_id: traineeId,
          actor_role: 'coached_student',
          anchor_date: ctx.today,
          offset_days: 1,
          created_at: new Date('2026-07-11T07:00:00.000Z'),
        },
        {
          id: latestBatchId,
          plan_id: plan.id,
          actor_id: coachId,
          actor_role: 'coach',
          anchor_date: ctx.today,
          offset_days: 2,
          created_at: new Date('2026-07-09T07:00:00.000Z'),
        },
      ])
      .execute();
    await ctx.db
      .insertInto('plan_day_shifts')
      .values([
        {
          id: '23000000-0000-4000-8000-000000000002',
          plan_day_id: first(days).id,
          student_id: traineeId,
          batch_id: previousBatchId,
          shifted_to_date: ctx.tomorrow,
          created_at: tiedCreatedAt,
        },
        {
          id: '23000000-0000-4000-8000-000000000001',
          plan_day_id: first(days).id,
          student_id: traineeId,
          batch_id: latestBatchId,
          shifted_to_date: '2026-07-13',
          created_at: tiedCreatedAt,
        },
      ])
      .execute();

    const detail = await request(ctx.app).get(`/plans/${plan.id}`).set(auth(ctx.coachToken));

    expect(detail.status).toBe(200);
    expect(detail.body.days[0].shifted_to_date).toBe('2026-07-13');
    expect(detail.body.latest_shift).toMatchObject({
      batch_id: latestBatchId,
      actor_role: 'coach',
      offset_days: 2,
      created_at: '2026-07-09T07:00:00.000Z',
    });

    const undone = await request(ctx.app)
      .delete(`/plans/${plan.id}/shift`)
      .set(auth(ctx.coachToken));
    const restored = await request(ctx.app).get(`/plans/${plan.id}`).set(auth(ctx.coachToken));

    expect(undone.status).toBe(204);
    expect(restored.body.days[0].shifted_to_date).toBe(ctx.tomorrow);
    expect(restored.body.latest_shift.batch_id).toBe(previousBatchId);
    expect(
      await ctx.db
        .selectFrom('plan_day_shifts')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('batch_id', '=', latestBatchId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: 0 });
  });

  it('treats a later legacy write as latest even when its created_at is earlier', async () => {
    const ctx = await makeContext({ COACH_PLAN_SHIFT_ENABLED: true });
    const { plan, days } = await seedPlan(ctx, { dayOffsets: [0, 2] });
    const coachShift = await request(ctx.app)
      .post(`/plans/${plan.id}/shift`)
      .set(auth(ctx.coachToken))
      .send({ anchor_date: ctx.today, offset_days: 1 });
    expect(coachShift.status).toBe(201);

    const [firstDay, secondDay] = days;
    if (firstDay === undefined || secondDay === undefined) {
      throw new Error('Expected two seeded plan days');
    }
    const legacyBatchId = '24000000-0000-4000-8000-000000000001';
    const legacyCreatedAt = new Date('2026-07-01T07:00:00.000Z');
    await ctx.db
      .insertInto('plan_day_shifts')
      .values([
        {
          plan_day_id: firstDay.id,
          student_id: traineeId,
          batch_id: legacyBatchId,
          shifted_to_date: '2026-07-13',
          created_at: legacyCreatedAt,
        },
        {
          plan_day_id: secondDay.id,
          student_id: traineeId,
          batch_id: legacyBatchId,
          shifted_to_date: '2026-07-15',
          created_at: legacyCreatedAt,
        },
      ])
      .execute();

    const stacked = await request(ctx.app).get(`/plans/${plan.id}`).set(auth(ctx.coachToken));
    expect(stacked.body.latest_shift).toEqual({
      batch_id: legacyBatchId,
      actor_role: 'coached_student',
      anchor_date: '2026-07-12',
      offset_days: 1,
      created_at: legacyCreatedAt.toISOString(),
    });
    expect(
      stacked.body.days.map((day: { shifted_to_date: string | null }) => day.shifted_to_date),
    ).toEqual(['2026-07-13', '2026-07-15']);
    expect(stacked.body.total_shift_days).toBe(2);

    const legacyUndone = await request(ctx.app)
      .delete(`/plans/${plan.id}/shift`)
      .set(auth(ctx.coachToken));
    expect(legacyUndone.status).toBe(204);
    const restored = await request(ctx.app).get(`/plans/${plan.id}`).set(auth(ctx.coachToken));
    expect(restored.body.latest_shift.batch_id).toBe(coachShift.body.batch_id);
    expect(
      restored.body.days.map((day: { shifted_to_date: string | null }) => day.shifted_to_date),
    ).toEqual(['2026-07-12', '2026-07-14']);
    expect(restored.body.total_shift_days).toBe(1);

    const coachUndone = await request(ctx.app)
      .delete(`/plans/${plan.id}/shift`)
      .set(auth(ctx.coachToken));
    expect(coachUndone.status).toBe(204);
    const original = await request(ctx.app).get(`/plans/${plan.id}`).set(auth(ctx.coachToken));
    expect(
      original.body.days.map((day: { shifted_to_date: string | null }) => day.shifted_to_date),
    ).toEqual([null, null]);
    expect(original.body).toMatchObject({
      total_shift_days: 0,
      latest_shift: null,
      latest_shift_created_at: null,
    });
  });

  it('serializes total_shift_days and latest_shift on detail and list responses', async () => {
    const ctx = await makeContext({ COACH_PLAN_SHIFT_ENABLED: true });
    const { plan } = await seedPlan(ctx, { dayOffsets: [0, 2] });
    const shifted = await request(ctx.app)
      .post(`/plans/${plan.id}/shift`)
      .set(auth(ctx.coachToken))
      .send({ anchor_date: ctx.today, offset_days: 3 });

    const detail = await request(ctx.app).get(`/plans/${plan.id}`).set(auth(ctx.coachToken));
    const list = await request(ctx.app)
      .get(`/students/${traineeId}/plans`)
      .set(auth(ctx.coachToken));
    const expected = {
      total_shift_days: 3,
      latest_shift: {
        batch_id: shifted.body.batch_id,
        actor_role: 'coach',
        anchor_date: ctx.today,
        offset_days: 3,
        created_at: expect.any(String),
      },
      latest_shift_created_at: expect.any(String),
    };
    expect(detail.body).toMatchObject(expected);
    expect(list.body.plans[0]).toMatchObject(expected);
  });

  it('rejects draft, foreign, empty-candidate, and invalid-body requests', async () => {
    const ctx = await makeContext({ COACH_PLAN_SHIFT_ENABLED: true });
    const draft = await seedPlan(ctx, { status: 'draft', dayOffsets: [0] });
    const published = await seedPlan(ctx, { dayOffsets: [0] });
    await completeDay(ctx, first(published.days).id);

    const draftResponse = await request(ctx.app)
      .post(`/plans/${draft.plan.id}/shift`)
      .set(auth(ctx.coachToken))
      .send({ anchor_date: ctx.today, offset_days: 1 });
    const foreignResponse = await request(ctx.app)
      .post(`/plans/${published.plan.id}/shift`)
      .set(auth(ctx.otherCoachToken))
      .send({ anchor_date: ctx.today, offset_days: 1 });
    const foreignDelete = await request(ctx.app)
      .delete(`/plans/${published.plan.id}/shift`)
      .set(auth(ctx.otherCoachToken));
    const emptyResponse = await request(ctx.app)
      .post(`/plans/${published.plan.id}/shift`)
      .set(auth(ctx.coachToken))
      .send({ anchor_date: ctx.today, offset_days: 1 });
    const invalidResponse = await request(ctx.app)
      .post(`/plans/${published.plan.id}/shift`)
      .set(auth(ctx.coachToken))
      .send({ anchor_date: '2026-02-30', offset_days: 1 });
    const nonStrictResponse = await request(ctx.app)
      .post(`/plans/${published.plan.id}/shift`)
      .set(auth(ctx.coachToken))
      .send({ anchor_date: ctx.today, offset_days: 1, extra: true });

    expect(draftResponse.body).toEqual({ error: 'PLAN_NOT_ACTIVE' });
    expect(draftResponse.status).toBe(409);
    expect(foreignResponse.body).toEqual({ error: 'PLAN_NOT_FOUND' });
    expect(foreignResponse.status).toBe(404);
    expect(foreignDelete.body).toEqual({ error: 'PLAN_NOT_FOUND' });
    expect(foreignDelete.status).toBe(404);
    expect(emptyResponse.body).toEqual({ error: 'SHIFT_NO_TARGET_DAYS' });
    expect(emptyResponse.status).toBe(409);
    expect(invalidResponse.body.error).toBe('VALIDATION_ERROR');
    expect(invalidResponse.status).toBe(400);
    expect(nonStrictResponse.body.error).toBe('VALIDATION_ERROR');
    expect(nonStrictResponse.status).toBe(400);
  });

  it('keeps the coached-student no-body +1 path when a coach body is supplied', async () => {
    const ctx = await makeContext({ COACH_PLAN_SHIFT_ENABLED: true });
    const { plan } = await seedPlan(ctx, { dayOffsets: [0] });

    const response = await request(ctx.app)
      .post(`/plans/${plan.id}/shift`)
      .set(auth(ctx.traineeToken))
      .send({ anchor_date: '2030-01-01', offset_days: 30 });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      shifted_days: [{ shifted_to_date: ctx.tomorrow }],
      total_offset_days: 1,
    });
    expect(response.body).not.toHaveProperty('anchor_date');
  });

  it('enqueues shifted and undone pushes only when PUSH_ENABLED is true', async () => {
    const enabled = await makeContext({ COACH_PLAN_SHIFT_ENABLED: true, PUSH_ENABLED: true });
    const { plan } = await seedPlan(enabled, { dayOffsets: [0] });
    const shifted = await request(enabled.app)
      .post(`/plans/${plan.id}/shift`)
      .set(auth(enabled.coachToken))
      .send({ anchor_date: enabled.today, offset_days: 1 });
    await request(enabled.app).delete(`/plans/${plan.id}/shift`).set(auth(enabled.coachToken));
    const enabledRows = await enabled.db
      .selectFrom('notification_outbox')
      .selectAll()
      .orderBy('created_at', 'asc')
      .execute();
    expect(enabledRows.map((row) => row.event_type)).toEqual(['plan_shifted', 'plan_shift_undone']);
    expect(enabledRows[0]?.payload).toEqual({
      coach_name: 'Coach A',
      student_id: traineeId,
      plan_id: plan.id,
      anchor_date: enabled.today,
      offset_days: 1,
    });
    expect(enabledRows[1]?.payload).toEqual({
      coach_name: 'Coach A',
      student_id: traineeId,
      plan_id: plan.id,
    });
    expect(enabledRows.every((row) => row.aggregate_id === shifted.body.batch_id)).toBe(true);

    const disabled = await makeContext({ COACH_PLAN_SHIFT_ENABLED: true, PUSH_ENABLED: false });
    const disabledPlan = await seedPlan(disabled, { dayOffsets: [0] });
    const disabledShifted = await request(disabled.app)
      .post(`/plans/${disabledPlan.plan.id}/shift`)
      .set(auth(disabled.coachToken))
      .send({ anchor_date: disabled.today, offset_days: 1 });
    const disabledUndone = await request(disabled.app)
      .delete(`/plans/${disabledPlan.plan.id}/shift`)
      .set(auth(disabled.coachToken));
    expect(disabledShifted.status).toBe(201);
    expect(disabledUndone.status).toBe(204);
    const disabledRows = await disabled.db.selectFrom('notification_outbox').selectAll().execute();
    expect(disabledRows).toHaveLength(0);
  });
});
