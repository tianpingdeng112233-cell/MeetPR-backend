import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import type { Kysely } from 'kysely';
import { DataType, newDb } from 'pg-mem';
import pino from 'pino';
import request, { type Response } from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/app';
import type { Config } from '../../src/config';
import { createDb } from '../../src/db/kysely';
import type { Database, UserRole } from '../../src/db/types';

const config: Config = {
  NODE_ENV: 'test',
  PORT: 3000,
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  JWT_ACCESS_SECRET: 'access-secret-for-plan-tests-minimum-length-32',
  JWT_REFRESH_SECRET: 'refresh-secret-for-plan-tests-minimum-length-32',
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_TTL: '30d',
  LOG_LEVEL: 'silent',
  RATE_LIMIT_WINDOW_MS: 60_000,
  RATE_LIMIT_MAX: 10_000,
  CORS_ORIGIN: '*',
  EVENTS_RATE_LIMIT_WINDOW_MS: 60_000,
  EVENTS_RATE_LIMIT_MAX: 10_000,
  ANALYTICS_ENABLED: true,
  SIGNALS_CRON_ENABLED: true,
  PUSH_ENABLED: false,
  PUSH_DAILY_DIGEST_ENABLED: false,
  ANALYTICS_SAMPLE_RATE: 1,
  TRUST_PROXY: 0,
};

const coachId = '10000000-0000-4000-8000-000000000001';
const otherCoachId = '10000000-0000-4000-8000-000000000002';
const traineeId = '10000000-0000-4000-8000-000000000003';
const otherStudentId = '10000000-0000-4000-8000-000000000004';
const casedStudentId = 'aaaaaaaa-0000-4000-8000-0000000000aa';

interface TestContext {
  app: ReturnType<typeof createApp>;
  db: Kysely<Database>;
  coachToken: string;
  otherCoachToken: string;
  traineeToken: string;
  otherStudentToken: string;
}

function signToken(userId: string, role: UserRole): string {
  return jwt.sign({ sub: userId, role }, config.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: '15m',
  });
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function responseId(response: Response): string {
  return (response.body as { id: string }).id;
}

async function makeContext(logger = pino({ level: 'silent' })): Promise<TestContext> {
  const mem = newDb();
  mem.public.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.uuid,
    impure: true,
    implementation: randomUUID,
  });
  mem.public.registerFunction({
    name: 'length',
    args: [DataType.text],
    returns: DataType.integer,
    implementation: (value: string) => value.length,
  });

  mem.public.none(fs.readFileSync('db/migrations/0001-init-users.sql', 'utf8'));
  mem.public.none(`
    CREATE TABLE exercises (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      name_en TEXT,
      exercise_type TEXT NOT NULL,
      main_lift_family TEXT,
      is_competition_lift BOOLEAN NOT NULL DEFAULT FALSE,
      competition_stance TEXT,
      muscle_groups TEXT[] NOT NULL,
      equipment TEXT[] NOT NULL,
      movement_pattern TEXT[] NOT NULL DEFAULT '{}',
      created_by_coach_id UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    INSERT INTO exercises (id, name, exercise_type, main_lift_family, is_competition_lift, muscle_groups, equipment, movement_pattern) VALUES
      ('20000000-0000-4000-8000-000000000001', '竞技深蹲', 'main_lift', 'squat', TRUE, ARRAY['quad','glute','core']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY[]::TEXT[]),
      ('20000000-0000-4000-8000-000000000002', '高杠深蹲', 'main_lift_variation', 'squat', FALSE, ARRAY['quad','glute','core']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY[]::TEXT[]),
      ('20000000-0000-4000-8000-000000000003', '哈克深蹲', 'main_lift_variation', 'squat', FALSE, ARRAY['quad','glute']::TEXT[], ARRAY['machine']::TEXT[], ARRAY[]::TEXT[]),
      ('20000000-0000-4000-8000-000000000004', '竞技卧推', 'main_lift', 'bench', TRUE, ARRAY['chest','triceps','shoulder']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY['horizontal_push']::TEXT[]),
      ('20000000-0000-4000-8000-000000000005', '窄距卧推', 'main_lift_variation', 'bench', FALSE, ARRAY['triceps','chest']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY['horizontal_push']::TEXT[]),
      ('20000000-0000-4000-8000-000000000006', '传统硬拉', 'main_lift', 'deadlift', TRUE, ARRAY['hamstring','glute','back','core']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY['hip_hinge']::TEXT[]),
      ('20000000-0000-4000-8000-000000000007', '相扑硬拉', 'main_lift_variation', 'deadlift', FALSE, ARRAY['hamstring','glute','quad','back','core']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY['hip_hinge']::TEXT[]),
      ('20000000-0000-4000-8000-000000000008', '引体向上', 'accessory', NULL, FALSE, ARRAY['back','biceps']::TEXT[], ARRAY['bodyweight']::TEXT[], ARRAY['vertical_pull']::TEXT[]),
      ('20000000-0000-4000-8000-000000000009', '杠铃划船', 'accessory', NULL, FALSE, ARRAY['back','biceps']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY['horizontal_pull']::TEXT[]),
      ('20000000-0000-4000-8000-000000000010', '哑铃肩推', 'accessory', NULL, FALSE, ARRAY['shoulder','triceps']::TEXT[], ARRAY['dumbbell']::TEXT[], ARRAY['vertical_push']::TEXT[]),
      ('20000000-0000-4000-8000-000000000011', '臂屈伸', 'accessory', NULL, FALSE, ARRAY['triceps','chest']::TEXT[], ARRAY['bodyweight']::TEXT[], ARRAY['horizontal_push']::TEXT[]),
      ('20000000-0000-4000-8000-000000000012', '哑铃弯举', 'accessory', NULL, FALSE, ARRAY['biceps']::TEXT[], ARRAY['dumbbell']::TEXT[], ARRAY['other']::TEXT[]),
      ('20000000-0000-4000-8000-000000000013', '罗马尼亚硬拉', 'accessory', NULL, FALSE, ARRAY['hamstring','glute','back']::TEXT[], ARRAY['barbell']::TEXT[], ARRAY['hip_hinge']::TEXT[]),
      ('20000000-0000-4000-8000-000000000014', '腿举', 'accessory', NULL, FALSE, ARRAY['quad','glute']::TEXT[], ARRAY['machine']::TEXT[], ARRAY[]::TEXT[]),
      ('20000000-0000-4000-8000-000000000015', '卷腹', 'accessory', NULL, FALSE, ARRAY['core']::TEXT[], ARRAY['bodyweight']::TEXT[], ARRAY[]::TEXT[]);

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
      block_type TEXT,
      mesocycle_phase TEXT,
      training_max NUMERIC,
      tm_set_at TIMESTAMPTZ,
      published_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );


    CREATE TABLE evaluation_periods (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      coach_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      bind_request_id UUID NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expected_end_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      completion_type TEXT
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
      exercise_id UUID NOT NULL REFERENCES exercises(id) ON DELETE RESTRICT,
      is_main_lift BOOLEAN NOT NULL DEFAULT FALSE,
      sort_order INT NOT NULL DEFAULT 0,
      notes TEXT
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
      target_value TEXT NOT NULL,
      set_type TEXT NOT NULL,
      rest_seconds INT,
      coach_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Post-0034 shape: plan history guards and the imported-history endpoint
    -- both read/write set_logs from the plans router. Keep in sync with
    -- tests/helpers/studentActions.ts.
    CREATE TABLE set_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_exercise_id UUID REFERENCES plan_exercises(id) ON DELETE RESTRICT,
      exercise_id UUID NOT NULL REFERENCES exercises(id),
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

    -- Publishing re-checks the accepted bond (server-side gate) and records a
    -- durable notification. Keep in sync with tests/helpers/studentActions.ts.
    CREATE TABLE bind_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      coach_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      responded_at TIMESTAMPTZ,
      expired_at TIMESTAMPTZ NOT NULL,
      skip_evaluation BOOLEAN NOT NULL DEFAULT FALSE,
      rejection_silent BOOLEAN NOT NULL DEFAULT TRUE
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
  // Final shape of db/migrations/0037 + 0038 (pg-mem cannot replay 0038's
  // DROP CONSTRAINT because it names 0037's inline UNIQUE differently than
  // real Postgres). Keep in sync with those migrations.
  mem.public.none(`
    CREATE TABLE plan_day_shifts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_day_id UUID NOT NULL REFERENCES plan_days(id) ON DELETE CASCADE,
      student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
      {
        id: coachId,
        phone: '+8613800001001',
        password_hash: 'hash',
        role: 'coach',
      },
      {
        id: otherCoachId,
        phone: '+8613800001002',
        password_hash: 'hash',
        role: 'coach',
      },
      {
        id: traineeId,
        phone: '+8613800001003',
        password_hash: 'hash',
        role: 'coached_student',
      },
      {
        id: otherStudentId,
        phone: '+8613800001004',
        password_hash: 'hash',
        role: 'coached_student',
      },
    ])
    .execute();

  await db
    .insertInto('bind_requests')
    .values({
      student_id: traineeId,
      coach_id: coachId,
      status: 'accepted',
      expired_at: new Date('2026-05-22T00:00:00.000Z'),
    })
    .execute();

  return {
    app: createApp({ config, logger, db }),
    db,
    coachToken: signToken(coachId, 'coach'),
    otherCoachToken: signToken(otherCoachId, 'coach'),
    traineeToken: signToken(traineeId, 'coached_student'),
    otherStudentToken: signToken(otherStudentId, 'coached_student'),
  };
}

async function firstSystemExerciseId(db: Kysely<Database>): Promise<string> {
  const exercise = await db
    .selectFrom('exercises')
    .select(['id'])
    .where('created_by_coach_id', 'is', null)
    .where('name', '=', '竞技深蹲')
    .executeTakeFirstOrThrow();
  return exercise.id;
}

async function createPlan(ctx: TestContext, token = ctx.coachToken) {
  return request(ctx.app).post('/plans').set(auth(token)).send({
    trainee_id: traineeId,
    name: 'Squat / Bench Block 1',
    start_date: '2026-05-04',
    end_date: '2026-06-01',
    plan_weeks: 4,
    source: 'coach',
  });
}

async function addDay(ctx: TestContext, planId: string) {
  return request(ctx.app).post(`/plans/${planId}/days`).set(auth(ctx.coachToken)).send({
    day_of_week: 1,
    week_number: 1,
    sort_order: 0,
  });
}

async function addExercise(ctx: TestContext, dayId: string, exerciseId?: string) {
  return request(ctx.app)
    .post(`/plans/days/${dayId}/exercises`)
    .set(auth(ctx.coachToken))
    .send({
      exercise_id: exerciseId ?? (await firstSystemExerciseId(ctx.db)),
      is_main_lift: true,
      sort_order: 0,
      notes: null,
    });
}

async function addSet(
  ctx: TestContext,
  planExerciseId: string,
  targetValue = '180.5',
  restSeconds?: number | null,
) {
  const body: {
    set_number: number;
    target_reps: number;
    target_reps_max: number | null;
    intensity_mode: 'weight';
    target_value: string;
    set_type: 'working';
    rest_seconds?: number | null;
  } = {
    set_number: 1,
    target_reps: 5,
    target_reps_max: null,
    intensity_mode: 'weight',
    target_value: targetValue,
    set_type: 'working',
  };
  if (restSeconds !== undefined) {
    body.rest_seconds = restSeconds;
  }

  return request(ctx.app)
    .post(`/plans/exercises/${planExerciseId}/sets`)
    .set(auth(ctx.coachToken))
    .send(body);
}

async function createCompleteDraft(ctx: TestContext) {
  const plan = await createPlan(ctx);
  const day = await addDay(ctx, responseId(plan));
  const exercise = await addExercise(ctx, responseId(day));
  const set = await addSet(ctx, responseId(exercise));
  return { plan, day, exercise, set };
}

describe('coach planning CRUD', () => {
  it('POST /plans creates a draft plan for a student-role trainee', async () => {
    const ctx = await makeContext();
    const response = await createPlan(ctx);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      coach_id: coachId,
      trainee_id: traineeId,
      name: 'Squat / Bench Block 1',
      start_date: '2026-05-04',
      end_date: '2026-06-01',
      plan_weeks: 4,
      source: 'coach',
      source_template_id: null,
      status: 'draft',
      block_type: null,
      mesocycle_phase: null,
      training_max: null,
      tm_set_at: null,
      published_at: null,
    });
  });

  it('computes training_max from raw 1RM and rejects forged client TM', async () => {
    const ctx = await makeContext();
    const created = await request(ctx.app).post('/plans').set(auth(ctx.coachToken)).send({
      trainee_id: traineeId,
      name: 'TM Block',
      start_date: '2026-05-04',
      end_date: '2026-06-01',
      plan_weeks: 4,
      source: 'coach',
      one_rm_kg: 102.5,
    });

    expect(created.status).toBe(201);
    expect(created.body.training_max).toBe('92.50');
    expect(created.body.tm_set_at).toEqual(expect.any(String));

    const forged = await request(ctx.app)
      .patch(`/plans/${responseId(created)}`)
      .set(auth(ctx.coachToken))
      .send({ training_max: 1 });
    expect(forged.status).toBe(400);
    expect(forged.body.error).toBe('VALIDATION_ERROR');

    const recalculated = await request(ctx.app)
      .patch(`/plans/${responseId(created)}`)
      .set(auth(ctx.coachToken))
      .send({ one_rm_kg: 100 });
    expect(recalculated.status).toBe(200);
    expect(recalculated.body.training_max).toBe('90.00');
    expect(recalculated.body.tm_set_at).toEqual(expect.any(String));
  });

  it('GET /plans/:id returns a coach-owned draft with empty children', async () => {
    const ctx = await makeContext();
    const plan = await createPlan(ctx);

    const response = await request(ctx.app)
      .get(`/plans/${responseId(plan)}`)
      .set(auth(ctx.coachToken));

    expect(response.status).toBe(200);
    expect(response.body.days).toEqual([]);
  });

  it('PATCH /plans/:id updates top-level plan fields', async () => {
    const ctx = await makeContext();
    const plan = await createPlan(ctx);

    const response = await request(ctx.app)
      .patch(`/plans/${responseId(plan)}`)
      .set(auth(ctx.coachToken))
      .send({ name: 'Renamed Block' });

    expect(response.status).toBe(200);
    expect(response.body.name).toBe('Renamed Block');
  });

  it('DELETE /plans/:id deletes an owned draft plan and cascades its tree', async () => {
    const ctx = await makeContext();
    const { plan } = await createCompleteDraft(ctx);

    const response = await request(ctx.app)
      .delete(`/plans/${responseId(plan)}`)
      .set(auth(ctx.coachToken));

    expect(response.status).toBe(204);
    expect(await ctx.db.selectFrom('plans').selectAll().execute()).toEqual([]);
    expect(await ctx.db.selectFrom('plan_days').selectAll().execute()).toEqual([]);
    expect(await ctx.db.selectFrom('plan_exercises').selectAll().execute()).toEqual([]);
    expect(await ctx.db.selectFrom('plan_sets').selectAll().execute()).toEqual([]);
  });

  it('DELETE /plans/:id rejects a non-draft plan with its current status', async () => {
    const ctx = await makeContext();
    const { plan } = await createCompleteDraft(ctx);
    await ctx.db
      .updateTable('plans')
      .set({ status: 'published' })
      .where('id', '=', responseId(plan))
      .execute();

    const response = await request(ctx.app)
      .delete(`/plans/${responseId(plan)}`)
      .set(auth(ctx.coachToken));

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'PLAN_TREE_IMMUTABLE', status: 'published' });
  });

  it('DELETE /plans/:id rejects a draft plan with set-log history', async () => {
    const ctx = await makeContext();
    const { plan, exercise } = await createCompleteDraft(ctx);
    await ctx.db
      .insertInto('set_logs')
      .values({
        student_id: traineeId,
        plan_exercise_id: responseId(exercise),
        exercise_id: await firstSystemExerciseId(ctx.db),
        set_index: 0,
        weight_kg: '180.00',
        reps: 5,
        completed: true,
        logged_date: '2026-05-04',
      })
      .execute();

    const response = await request(ctx.app)
      .delete(`/plans/${responseId(plan)}`)
      .set(auth(ctx.coachToken));

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'PLAN_HISTORY_IMMUTABLE' });
    expect(await ctx.db.selectFrom('plans').selectAll().execute()).toHaveLength(1);
  });

  it('DELETE /plans/:id hides another coach plan', async () => {
    const ctx = await makeContext();
    const plan = await createPlan(ctx);

    const response = await request(ctx.app)
      .delete(`/plans/${responseId(plan)}`)
      .set(auth(ctx.otherCoachToken));

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'PLAN_NOT_FOUND' });
  });

  it('POST /plans/:id/publish publishes a complete draft and logs the notification stub', async () => {
    const logLines: string[] = [];
    const logger = pino(
      {
        level: 'info',
        base: null,
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            '*.password',
            '*.token',
            '*.accessToken',
            '*.refreshToken',
          ],
          censor: '[REDACTED]',
        },
      },
      { write: (line: string) => logLines.push(line) },
    );
    const ctx = await makeContext(logger);
    const { plan } = await createCompleteDraft(ctx);

    const response = await request(ctx.app)
      .post(`/plans/${responseId(plan)}/publish`)
      .set(auth(ctx.coachToken));

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('published');
    const joinedLogs = logLines.join('\n');
    expect(joinedLogs).toContain('plan_created');
    expect(joinedLogs).toContain('plan_published_notification_stub');
    expect(joinedLogs).not.toContain(ctx.coachToken);
    expect(joinedLogs).not.toContain('"name":"Squat / Bench Block 1"');
  });

  it('records a durable notification_outbox row on publish', async () => {
    const ctx = await makeContext();
    const { plan } = await createCompleteDraft(ctx);

    const response = await request(ctx.app)
      .post(`/plans/${responseId(plan)}/publish`)
      .set(auth(ctx.coachToken));
    expect(response.status).toBe(200);

    const outbox = await ctx.db.selectFrom('notification_outbox').selectAll().execute();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      event_type: 'plan_published',
      aggregate_id: responseId(plan),
      recipient_id: traineeId,
      status: 'pending',
    });
  });

  it('rejects publishing once the accepted bond is gone (server-side gate)', async () => {
    const ctx = await makeContext();
    const { plan } = await createCompleteDraft(ctx);
    await ctx.db
      .updateTable('bind_requests')
      .set({ status: 'cancelled' })
      .where('coach_id', '=', coachId)
      .where('student_id', '=', traineeId)
      .execute();

    const response = await request(ctx.app)
      .post(`/plans/${responseId(plan)}/publish`)
      .set(auth(ctx.coachToken));

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'BIND_NOT_ACCEPTED' });
    const outbox = await ctx.db.selectFrom('notification_outbox').selectAll().execute();
    expect(outbox).toEqual([]);
    const stillDraft = await ctx.db
      .selectFrom('plans')
      .select('status')
      .where('id', '=', responseId(plan))
      .executeTakeFirstOrThrow();
    expect(stillDraft.status).toBe('draft');
  });

  it('GET /students/:studentId/plans lists coach plans ordered newest first', async () => {
    const ctx = await makeContext();
    await createPlan(ctx);

    const response = await request(ctx.app)
      .get(`/students/${traineeId}/plans`)
      .set(auth(ctx.coachToken));

    expect(response.status).toBe(200);
    expect(response.body.plans).toHaveLength(1);
  });

  it('allows uppercase UUID path for owning student plan list and still forbids other students', async () => {
    const ctx = await makeContext();
    const casedStudentToken = signToken(casedStudentId, 'coached_student');
    await ctx.db
      .insertInto('users')
      .values({
        id: casedStudentId,
        phone: '+8613800001099',
        password_hash: 'hash',
        role: 'coached_student',
      })
      .execute();
    const plan = await ctx.db
      .insertInto('plans')
      .values({
        coach_id: coachId,
        trainee_id: casedStudentId,
        name: 'Published Case Regression',
        start_date: '2026-05-04',
        end_date: '2026-06-01',
        plan_weeks: 4,
        source: 'coach',
        status: 'published',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const path = `/students/${casedStudentId.toUpperCase()}/plans`;
    const owningStudent = await request(ctx.app).get(path).set(auth(casedStudentToken));
    expect(owningStudent.status).toBe(200);
    expect((owningStudent.body.plans as { id: string }[]).map((item) => item.id)).toEqual([
      plan.id,
    ]);

    const otherStudent = await request(ctx.app).get(path).set(auth(ctx.otherStudentToken));
    expect(otherStudent.status).toBe(403);
    expect(otherStudent.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });
  });

  it('creates, patches, and deletes plan days', async () => {
    const ctx = await makeContext();
    const plan = await createPlan(ctx);
    const created = await addDay(ctx, responseId(plan));

    expect(created.status).toBe(201);
    expect(created.body.day_of_week).toBe(1);

    const patched = await request(ctx.app)
      .patch(`/plans/days/${responseId(created)}`)
      .set(auth(ctx.coachToken))
      .send({ day_of_week: 2 });

    expect(patched.status).toBe(200);
    expect(patched.body.day_of_week).toBe(2);

    const deleted = await request(ctx.app)
      .delete(`/plans/days/${responseId(created)}`)
      .set(auth(ctx.coachToken));
    expect(deleted.status).toBe(204);
  });

  it('creates, patches, and deletes plan exercises', async () => {
    const ctx = await makeContext();
    const plan = await createPlan(ctx);
    const day = await addDay(ctx, responseId(plan));
    const created = await addExercise(ctx, responseId(day));

    expect(created.status).toBe(201);
    expect(created.body.sets).toEqual([]);

    const patched = await request(ctx.app)
      .patch(`/plans/exercises/${responseId(created)}`)
      .set(auth(ctx.coachToken))
      .send({ notes: 'Keep bar path tight' });

    expect(patched.status).toBe(200);
    expect(patched.body.notes).toBe('Keep bar path tight');

    const deleted = await request(ctx.app)
      .delete(`/plans/exercises/${responseId(created)}`)
      .set(auth(ctx.coachToken));
    expect(deleted.status).toBe(204);
  });

  it('creates, patches, and deletes plan sets while preserving target_value as string', async () => {
    const ctx = await makeContext();
    const { exercise } = await createCompleteDraft(ctx);
    const created = await addSet(ctx, responseId(exercise), '180.5', 120);

    expect(created.status).toBe(201);
    expect(created.body.target_value).toBe('180.50');
    expect(created.body.rest_seconds).toBe(120);

    const patched = await request(ctx.app)
      .patch(`/plans/sets/${responseId(created)}`)
      .set(auth(ctx.coachToken))
      .send({ intensity_mode: 'rpe', target_value: '7.5', rest_seconds: 90 });

    expect(patched.status).toBe(200);
    expect(patched.body.target_value).toBe('7.50');
    expect(patched.body.rest_seconds).toBe(90);

    const omitted = await addSet(ctx, responseId(exercise), '120');
    expect(omitted.status).toBe(201);
    expect(omitted.body.rest_seconds).toBeNull();

    const deleted = await request(ctx.app)
      .delete(`/plans/sets/${responseId(created)}`)
      .set(auth(ctx.coachToken));
    expect(deleted.status).toBe(204);
  });

  it('GET /exercises returns the 15 system exercises', async () => {
    const ctx = await makeContext();
    await ctx.db
      .updateTable('exercises')
      .set({ competition_stance: 'high_bar' })
      .where('name', '=', '高杠深蹲')
      .execute();

    const response = await request(ctx.app).get('/exercises').set(auth(ctx.coachToken));

    expect(response.status).toBe(200);
    expect(response.body.exercises).toHaveLength(15);
    expect(response.body.exercises).toContainEqual(
      expect.objectContaining({ name: '高杠深蹲', competition_stance: 'high_bar' }),
    );
    expect(response.body.exercises).toContainEqual(
      expect.objectContaining({ name: '竞技深蹲', competition_stance: null }),
    );
  });

  it('GET /exercises applies facet filters with AND across facets', async () => {
    const ctx = await makeContext();

    const response = await request(ctx.app)
      .get('/exercises?muscle_group=quad,glute&equipment=barbell')
      .set(auth(ctx.coachToken));

    expect(response.status).toBe(200);
    expect(response.body.exercises.length).toBeGreaterThan(0);
    for (const exercise of response.body.exercises as {
      muscle_groups: string[];
      equipment: string[];
    }[]) {
      expect(exercise.muscle_groups.some((group) => ['quad', 'glute'].includes(group))).toBe(true);
      expect(exercise.equipment).toContain('barbell');
    }
  });

  it('POST /exercises creates a coach custom exercise', async () => {
    const ctx = await makeContext();

    const response = await request(ctx.app)
      .post('/exercises')
      .set(auth(ctx.coachToken))
      .send({
        name: 'Tempo Squat',
        exercise_type: 'main_lift_variation',
        main_lift_family: 'squat',
        is_competition_lift: false,
        muscle_groups: ['quad', 'glute'],
        equipment: ['barbell'],
        movement_pattern: [],
      });

    expect(response.status).toBe(201);
    expect(response.body.created_by_coach_id).toBe(coachId);
  });

  it('GET /plans/:id returns the nested wire shape ordered as arrays', async () => {
    const ctx = await makeContext();
    const { plan, day, exercise } = await createCompleteDraft(ctx);
    await addSet(ctx, responseId(exercise), '120', 150);

    const publish = await request(ctx.app)
      .post(`/plans/${responseId(plan)}/publish`)
      .set(auth(ctx.coachToken));
    expect(publish.status).toBe(200);

    const response = await request(ctx.app)
      .get(`/plans/${responseId(plan)}`)
      .set(auth(ctx.traineeToken));

    expect(response.status).toBe(200);
    expect(response.body.days).toHaveLength(1);
    expect(response.body.days[0].id).toBe(responseId(day));
    expect(response.body.days[0].exercises).toHaveLength(1);
    expect(response.body.days[0].exercises[0].sets).toHaveLength(2);
    expect(typeof response.body.days[0].exercises[0].sets[0].target_value).toBe('string');
    expect(response.body.days[0].exercises[0].sets).toContainEqual(
      expect.objectContaining({ target_value: '120.00', rest_seconds: 150 }),
    );
    expect(response.body.days[0].exercises[0].sets).toContainEqual(
      expect.objectContaining({ rest_seconds: null }),
    );
    expect(response.body.password_hash).toBeUndefined();
  });

  it('students can resolve coach custom exercises referenced by their published plans', async () => {
    const ctx = await makeContext();
    const custom = await request(ctx.app)
      .post('/exercises')
      .set(auth(ctx.coachToken))
      .send({
        name: 'Custom Pin Squat',
        exercise_type: 'main_lift_variation',
        main_lift_family: 'squat',
        is_competition_lift: false,
        muscle_groups: ['quad'],
        equipment: ['barbell'],
        movement_pattern: [],
      });
    const plan = await createPlan(ctx);
    const day = await addDay(ctx, responseId(plan));
    const exercise = await addExercise(ctx, responseId(day), responseId(custom));
    await addSet(ctx, responseId(exercise));
    await request(ctx.app)
      .post(`/plans/${responseId(plan)}/publish`)
      .set(auth(ctx.coachToken));

    const response = await request(ctx.app).get('/exercises').set(auth(ctx.traineeToken));

    expect(response.status).toBe(200);
    const exerciseIds = (response.body.exercises as { id: string }[]).map((item) => item.id);
    expect(exerciseIds).toContain(responseId(custom));
  });

  it('rejects coach-only mutations for students', async () => {
    const ctx = await makeContext();
    const response = await createPlan(ctx, ctx.traineeToken);

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });
  });

  it('hides draft plans from the trainee', async () => {
    const ctx = await makeContext();
    const plan = await createPlan(ctx);

    const response = await request(ctx.app)
      .get(`/plans/${responseId(plan)}`)
      .set(auth(ctx.traineeToken));

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'PLAN_NOT_FOUND' });
  });

  it('hides another coach plan as PLAN_NOT_FOUND', async () => {
    const ctx = await makeContext();
    const plan = await createPlan(ctx);

    const response = await request(ctx.app)
      .get(`/plans/${responseId(plan)}`)
      .set(auth(ctx.otherCoachToken));

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'PLAN_NOT_FOUND' });
  });

  it('forbids a student from listing another student plans', async () => {
    const ctx = await makeContext();
    const response = await request(ctx.app)
      .get(`/students/${traineeId}/plans`)
      .set(auth(ctx.otherStudentToken));

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });
  });

  it('returns ownership-chain 404s for another coach day mutation', async () => {
    const ctx = await makeContext();
    const plan = await createPlan(ctx);
    const day = await addDay(ctx, responseId(plan));

    const response = await request(ctx.app)
      .patch(`/plans/days/${responseId(day)}`)
      .set(auth(ctx.otherCoachToken))
      .send({ day_of_week: 3 });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'PLAN_DAY_NOT_FOUND' });
  });

  it.each([
    ['plan_weeks', { plan_weeks: 53 }, ['plan_weeks']],
    ['missing template source id', { source: 'template' }, ['source_template_id']],
    ['date order', { start_date: '2026-06-01', end_date: '2026-05-04' }, ['end_date']],
  ])('rejects invalid plan creation: %s', async (_caseName, override, path) => {
    const ctx = await makeContext();
    const response = await request(ctx.app)
      .post('/plans')
      .set(auth(ctx.coachToken))
      .send({
        trainee_id: traineeId,
        name: 'Block',
        start_date: '2026-05-04',
        end_date: '2026-06-01',
        plan_weeks: 4,
        source: 'coach',
        ...override,
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('VALIDATION_ERROR');
    expect(response.body.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path })]),
    );
  });

  it('rejects plan creation when trainee_id is a coach', async () => {
    const ctx = await makeContext();
    const response = await request(ctx.app).post('/plans').set(auth(ctx.coachToken)).send({
      trainee_id: otherCoachId,
      name: 'Block',
      start_date: '2026-05-04',
      end_date: '2026-06-01',
      plan_weeks: 4,
      source: 'coach',
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'TRAINEE_NOT_FOUND' });
  });

  it.each([
    ['rpe out of range', { intensity_mode: 'rpe', target_value: '11.0' }, ['target_value']],
    ['rep range inverted', { target_reps: 8, target_reps_max: 5 }, ['target_reps_max']],
    ['target value over precision', { target_value: '180.555' }, ['target_value']],
  ])('rejects invalid set creation: %s', async (_caseName, override, path) => {
    const ctx = await makeContext();
    const { exercise } = await createCompleteDraft(ctx);
    const response = await request(ctx.app)
      .post(`/plans/exercises/${responseId(exercise)}/sets`)
      .set(auth(ctx.coachToken))
      .send({
        set_number: 2,
        target_reps: 5,
        intensity_mode: 'weight',
        target_value: '180.5',
        set_type: 'working',
        ...override,
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('VALIDATION_ERROR');
    expect(response.body.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path })]),
    );
  });

  it('rejects hidden custom exercises when adding a plan exercise', async () => {
    const ctx = await makeContext();
    const hidden = await ctx.db
      .insertInto('exercises')
      .values({
        name: 'Hidden Custom',
        exercise_type: 'accessory',
        main_lift_family: null,
        is_competition_lift: false,
        muscle_groups: ['back'],
        equipment: ['barbell'],
        movement_pattern: ['horizontal_pull'],
        created_by_coach_id: otherCoachId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const plan = await createPlan(ctx);
    const day = await addDay(ctx, responseId(plan));

    const response = await addExercise(ctx, responseId(day), hidden.id);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'EXERCISE_NOT_FOUND_OR_HIDDEN' });
  });

  it.each([
    [
      'accessory with main_lift_family',
      { exercise_type: 'accessory', main_lift_family: 'squat', muscle_groups: ['quad'] },
      ['main_lift_family'],
    ],
    ['empty muscle_groups', { muscle_groups: [] }, ['muscle_groups']],
  ])('rejects invalid custom exercise: %s', async (_caseName, override, path) => {
    const ctx = await makeContext();
    const payload = {
      name: 'Bad Exercise',
      exercise_type: 'main_lift_variation',
      main_lift_family: 'squat',
      is_competition_lift: false,
      muscle_groups: ['quad'],
      equipment: ['barbell'],
      movement_pattern: [],
    };
    Object.assign(payload, override);

    const response = await request(ctx.app)
      .post('/exercises')
      .set(auth(ctx.coachToken))
      .send(payload);

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('VALIDATION_ERROR');
    expect(response.body.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path })]),
    );
  });

  it('rejects PATCH /plans/:id status draft validation', async () => {
    const ctx = await makeContext();
    const plan = await createPlan(ctx);
    const response = await request(ctx.app)
      .patch(`/plans/${responseId(plan)}`)
      .set(auth(ctx.coachToken))
      .send({ status: 'draft' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('VALIDATION_ERROR');
  });

  it('rejects unknown/camelCase keys on plan create and patch (strict wire shape)', async () => {
    const ctx = await makeContext();

    const camelCreate = await request(ctx.app).post('/plans').set(auth(ctx.coachToken)).send({
      trainee_id: traineeId,
      name: 'Strict',
      start_date: '2026-06-15',
      end_date: '2026-07-12',
      planWeeks: 4,
      source: 'coach',
    });
    expect(camelCreate.status).toBe(400);
    expect(camelCreate.body.error).toBe('VALIDATION_ERROR');

    const created = await createPlan(ctx);
    const planId = (created.body as { id: string }).id;
    const kindPatch = await request(ctx.app)
      .patch(`/plans/${planId}`)
      .set(auth(ctx.coachToken))
      .send({ kind: 'adaptation' });
    expect(kindPatch.status).toBe(400);
    expect(kindPatch.body.error).toBe('VALIDATION_ERROR');
    const row = await ctx.db
      .selectFrom('plans')
      .select(['kind'])
      .where('id', '=', planId)
      .executeTakeFirstOrThrow();
    expect(row.kind).toBe('regular');
  });

  it('rejects publishing an already-published plan', async () => {
    const ctx = await makeContext();
    const { plan } = await createCompleteDraft(ctx);
    await request(ctx.app)
      .post(`/plans/${responseId(plan)}/publish`)
      .set(auth(ctx.coachToken));

    const response = await request(ctx.app)
      .post(`/plans/${responseId(plan)}/publish`)
      .set(auth(ctx.coachToken));

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'PLAN_NOT_DRAFT' });
  });

  it.each([
    ['zero days', async (ctx: TestContext) => responseId(await createPlan(ctx)), { day_count: 0 }],
    [
      'empty day',
      async (ctx: TestContext) => {
        const plan = await createPlan(ctx);
        await addDay(ctx, responseId(plan));
        return responseId(plan);
      },
      { empty_day_count: 1 },
    ],
    [
      'empty exercise',
      async (ctx: TestContext) => {
        const plan = await createPlan(ctx);
        const day = await addDay(ctx, responseId(plan));
        await addExercise(ctx, responseId(day));
        return responseId(plan);
      },
      { empty_exercise_count: 1 },
    ],
  ])('rejects publishing incomplete plans: %s', async (_caseName, buildPlan, expected) => {
    const ctx = await makeContext();
    const planId = await buildPlan(ctx);

    const response = await request(ctx.app)
      .post(`/plans/${planId}/publish`)
      .set(auth(ctx.coachToken));

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ error: 'PLAN_PUBLISH_INCOMPLETE', ...expected });

    const plan = await ctx.db
      .selectFrom('plans')
      .select(['status'])
      .where('id', '=', planId)
      .executeTakeFirstOrThrow();
    expect(plan.status).toBe('draft');
  });

  it('deleting a day cascades child exercises and sets', async () => {
    const ctx = await makeContext();
    const { day } = await createCompleteDraft(ctx);

    const response = await request(ctx.app)
      .delete(`/plans/days/${responseId(day)}`)
      .set(auth(ctx.coachToken));

    expect(response.status).toBe(204);
    const exerciseCount = await ctx.db
      .selectFrom('plan_exercises')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .executeTakeFirstOrThrow();
    const setCount = await ctx.db
      .selectFrom('plan_sets')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .executeTakeFirstOrThrow();
    expect(exerciseCount.count).toBe(0);
    expect(setCount.count).toBe(0);
  });

  it('rejects unknown exercise filter values', async () => {
    const ctx = await makeContext();
    const response = await request(ctx.app)
      .get('/exercises?equipment=garbage')
      .set(auth(ctx.coachToken));

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('VALIDATION_ERROR');
  });
});

describe('spec 043: relaxed plan weeks + coach note', () => {
  function createPlanWeeks(ctx: TestContext, planWeeks: number, endDate: string) {
    return request(ctx.app).post('/plans').set(auth(ctx.coachToken)).send({
      trainee_id: traineeId,
      name: 'Imported remaining block',
      start_date: '2026-05-04',
      end_date: endDate,
      plan_weeks: planWeeks,
      source: 'coach',
    });
  }

  function addDayAt(ctx: TestContext, planId: string, weekNumber: number) {
    return request(ctx.app).post(`/plans/${planId}/days`).set(auth(ctx.coachToken)).send({
      day_of_week: 1,
      week_number: weekNumber,
      sort_order: 0,
    });
  }

  it('accepts plan_weeks=2 on creation (relaxed from the {1,4} presets)', async () => {
    const ctx = await makeContext();
    const response = await createPlanWeeks(ctx, 2, '2026-05-17');

    expect(response.status).toBe(201);
    expect(response.body.plan_weeks).toBe(2);
  });

  it('still accepts the legacy plan_weeks=1 preset', async () => {
    const ctx = await makeContext();
    const response = await createPlanWeeks(ctx, 1, '2026-05-10');

    expect(response.status).toBe(201);
    expect(response.body.plan_weeks).toBe(1);
  });

  it('publishes a 2-week plan whose day sits in week 2 (week_number <= plan_weeks)', async () => {
    const ctx = await makeContext();
    const plan = await createPlanWeeks(ctx, 2, '2026-05-17');
    const day = await addDayAt(ctx, responseId(plan), 2);
    const exercise = await addExercise(ctx, responseId(day));
    await addSet(ctx, responseId(exercise));

    const publish = await request(ctx.app)
      .post(`/plans/${responseId(plan)}/publish`)
      .set(auth(ctx.coachToken));

    expect(publish.status).toBe(200);
    expect(publish.body.status).toBe('published');
  });

  it('rejects publishing when a day sits beyond plan_weeks (week_number > plan_weeks)', async () => {
    const ctx = await makeContext();
    const plan = await createPlanWeeks(ctx, 2, '2026-05-17');
    const day = await addDayAt(ctx, responseId(plan), 3);
    const exercise = await addExercise(ctx, responseId(day));
    await addSet(ctx, responseId(exercise));

    const publish = await request(ctx.app)
      .post(`/plans/${responseId(plan)}/publish`)
      .set(auth(ctx.coachToken));

    expect(publish.status).toBe(422);
    expect(publish.body).toEqual({ error: 'PLAN_DAYS_EXCEED_WEEKS' });
  });

  it('round-trips coach_note from create through the plan tree read', async () => {
    const ctx = await makeContext();
    const plan = await createPlanWeeks(ctx, 2, '2026-05-17');
    const day = await addDayAt(ctx, responseId(plan), 1);
    const exercise = await addExercise(ctx, responseId(day));

    const createSet = await request(ctx.app)
      .post(`/plans/exercises/${responseId(exercise)}/sets`)
      .set(auth(ctx.coachToken))
      .send({
        set_number: 1,
        target_reps: 5,
        target_reps_max: null,
        intensity_mode: 'weight',
        target_value: '120',
        set_type: 'working',
        coach_note: '70%top',
      });
    expect(createSet.status).toBe(201);
    expect(createSet.body.coach_note).toBe('70%top');

    const tree = await request(ctx.app)
      .get(`/plans/${responseId(plan)}`)
      .set(auth(ctx.coachToken));
    expect(tree.status).toBe(200);
    expect(tree.body.days[0].exercises[0].sets[0].coach_note).toBe('70%top');
  });

  it('defaults coach_note to null when omitted', async () => {
    const ctx = await makeContext();
    const plan = await createPlanWeeks(ctx, 1, '2026-05-10');
    const day = await addDayAt(ctx, responseId(plan), 1);
    const exercise = await addExercise(ctx, responseId(day));
    const set = await addSet(ctx, responseId(exercise));

    expect(set.status).toBe(201);
    expect(set.body.coach_note).toBeNull();
  });
});
