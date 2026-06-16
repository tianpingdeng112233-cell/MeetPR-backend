import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Kysely } from 'kysely';
import { DataType, newDb } from 'pg-mem';
import pino from 'pino';
import type { Response } from 'supertest';

import { createApp } from '../../src/app';
import type { Config } from '../../src/config';
import { createDb } from '../../src/db/kysely';
import type { Database, UserRole } from '../../src/db/types';
import type { OssService } from '../../src/services/oss';

export const config: Config = {
  NODE_ENV: 'test',
  PORT: 3000,
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  JWT_ACCESS_SECRET: 'access-secret-for-student-actions-tests-32',
  JWT_REFRESH_SECRET: 'refresh-secret-for-student-actions-tests-32',
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_TTL: '30d',
  LOG_LEVEL: 'silent',
  RATE_LIMIT_WINDOW_MS: 60_000,
  RATE_LIMIT_MAX: 10_000,
  CORS_ORIGIN: '*',
  TRUST_PROXY: 0,
};

export const ids = {
  coach: '10000000-0000-4000-8000-000000000001',
  otherCoach: '10000000-0000-4000-8000-000000000002',
  trainee: '10000000-0000-4000-8000-000000000003',
  otherStudent: '10000000-0000-4000-8000-000000000004',
  selfTrainStudent: '10000000-0000-4000-8000-000000000005',
  exercise: '20000000-0000-4000-8000-000000000001',
};

export interface TestContext {
  app: ReturnType<typeof createApp>;
  db: Kysely<Database>;
  coachToken: string;
  otherCoachToken: string;
  traineeToken: string;
  otherStudentToken: string;
  selfTrainStudentToken: string;
}

export interface PublishedPlanFixture {
  planId: string;
  dayId: string;
  planExerciseId: string;
}

export function signToken(userId: string, role: UserRole): string {
  return jwt.sign({ sub: userId, role }, config.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: '15m',
  });
}

export function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

export function responseId(response: Response): string {
  return (response.body as { id: string }).id;
}

function registerPgMemFunctions(mem: ReturnType<typeof newDb>): void {
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
  mem.public.registerFunction({
    name: 'trim',
    args: [DataType.text],
    returns: DataType.text,
    implementation: (value: string) => value.trim(),
  });
}

function createSchema(mem: ReturnType<typeof newDb>): void {
  mem.public.none(`
    CREATE TABLE users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      phone TEXT NOT NULL UNIQUE,
      apple_user_id TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      refresh_token_jti UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE exercises (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      name_en TEXT,
      exercise_type TEXT NOT NULL,
      main_lift_family TEXT,
      is_competition_lift BOOLEAN NOT NULL DEFAULT FALSE,
      muscle_groups TEXT[] NOT NULL,
      equipment TEXT[] NOT NULL,
      movement_pattern TEXT[] NOT NULL DEFAULT '{}',
      created_by_coach_id UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE plans (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      coach_id UUID REFERENCES users(id) ON DELETE RESTRICT,
      trainee_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      plan_weeks SMALLINT NOT NULL,
      source TEXT NOT NULL,
      source_template_id UUID,
      status TEXT NOT NULL DEFAULT 'draft',
      kind TEXT NOT NULL DEFAULT 'regular',
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE coach_profiles (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      display_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE student_profiles (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      display_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

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

    CREATE UNIQUE INDEX bind_requests_unique_accepted
      ON bind_requests (student_id, coach_id) WHERE status = 'accepted';

    CREATE TABLE set_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_exercise_id UUID NOT NULL REFERENCES plan_exercises(id) ON DELETE CASCADE,
      set_index INT NOT NULL,
      weight_kg NUMERIC(6,2) NOT NULL,
      reps INT NOT NULL,
      rpe NUMERIC(3,1),
      completed BOOLEAN NOT NULL DEFAULT FALSE,
      failed BOOLEAN NOT NULL DEFAULT FALSE,
      logged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (student_id, plan_exercise_id, set_index)
    );

    CREATE TABLE readiness_checkins (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      checkin_date DATE NOT NULL,
      sleep_quality SMALLINT NOT NULL,
      mood SMALLINT NOT NULL,
      stress SMALLINT NOT NULL,
      muscle_fatigue JSONB NOT NULL DEFAULT '[]',
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (student_id, checkin_date)
    );

    CREATE TABLE feedback (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      coach_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day_date DATE,
      plan_exercise_id UUID REFERENCES plan_exercises(id) ON DELETE SET NULL,
      text TEXT NOT NULL,
      posted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      read_at TIMESTAMPTZ
    );

    CREATE TABLE attachments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      oss_key TEXT NOT NULL UNIQUE,
      oss_upload_id TEXT,
      content_type TEXT NOT NULL,
      size_bytes BIGINT NOT NULL,
      filename TEXT,
      set_log_id UUID REFERENCES set_logs(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'uploading',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

export async function makeContext(
  logger = pino({ level: 'silent' }),
  extras: { oss?: OssService } = {},
): Promise<TestContext> {
  const mem = newDb();
  registerPgMemFunctions(mem);
  createSchema(mem);

  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  const db = createDb(pool);

  await db
    .insertInto('users')
    .values([
      {
        id: ids.coach,
        phone: '+8613800001001',
        password_hash: 'hash',
        role: 'coach',
      },
      {
        id: ids.otherCoach,
        phone: '+8613800001002',
        password_hash: 'hash',
        role: 'coach',
      },
      {
        id: ids.trainee,
        phone: '+8613800001003',
        password_hash: 'hash',
        role: 'coached_student',
      },
      {
        id: ids.otherStudent,
        phone: '+8613800001004',
        password_hash: 'hash',
        role: 'coached_student',
      },
      {
        id: ids.selfTrainStudent,
        phone: '+8613800001005',
        password_hash: 'hash',
        role: 'self_train_student',
      },
    ])
    .execute();

  await db
    .insertInto('coach_profiles')
    .values([
      { user_id: ids.coach, display_name: 'Coach A' },
      { user_id: ids.otherCoach, display_name: 'Coach B' },
    ])
    .execute();

  await db
    .insertInto('student_profiles')
    .values([
      { user_id: ids.trainee, display_name: 'Trainee One' },
      { user_id: ids.otherStudent, display_name: 'Other Student' },
      { user_id: ids.selfTrainStudent, display_name: 'Self Student' },
    ])
    .execute();

  await db
    .insertInto('bind_requests')
    .values([
      {
        student_id: ids.trainee,
        coach_id: ids.coach,
        status: 'accepted',
        expired_at: new Date('2026-05-22T00:00:00.000Z'),
      },
      {
        student_id: ids.trainee,
        coach_id: ids.otherCoach,
        status: 'accepted',
        expired_at: new Date('2026-05-22T00:00:00.000Z'),
      },
    ])
    .execute();

  await db
    .insertInto('exercises')
    .values({
      id: ids.exercise,
      name: 'Competition Squat',
      exercise_type: 'main_lift',
      main_lift_family: 'squat',
      is_competition_lift: true,
      muscle_groups: ['quad', 'glute', 'core'],
      equipment: ['barbell'],
      movement_pattern: [],
    })
    .execute();

  return {
    app: createApp({ config, logger, db, ...extras }),
    db,
    coachToken: signToken(ids.coach, 'coach'),
    otherCoachToken: signToken(ids.otherCoach, 'coach'),
    traineeToken: signToken(ids.trainee, 'coached_student'),
    otherStudentToken: signToken(ids.otherStudent, 'coached_student'),
    selfTrainStudentToken: signToken(ids.selfTrainStudent, 'self_train_student'),
  };
}

export async function createPublishedPlan(
  ctx: TestContext,
  coachId = ids.coach,
  studentId = ids.trainee,
): Promise<PublishedPlanFixture> {
  const plan = await ctx.db
    .insertInto('plans')
    .values({
      coach_id: coachId,
      trainee_id: studentId,
      name: 'Published Block',
      start_date: '2026-05-01',
      end_date: '2026-05-28',
      plan_weeks: 4,
      source: 'coach',
      source_template_id: null,
      status: 'published',
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();

  const day = await ctx.db
    .insertInto('plan_days')
    .values({
      plan_id: plan.id,
      day_of_week: 1,
      week_number: 1,
      sort_order: 0,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();

  const exercise = await ctx.db
    .insertInto('plan_exercises')
    .values({
      plan_day_id: day.id,
      exercise_id: ids.exercise,
      is_main_lift: true,
      sort_order: 0,
      notes: null,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();

  await ctx.db
    .insertInto('plan_sets')
    .values({
      plan_exercise_id: exercise.id,
      set_number: 1,
      target_reps: 5,
      target_reps_max: null,
      intensity_mode: 'weight',
      target_value: '100.00',
      set_type: 'working',
      rest_seconds: null,
    })
    .execute();

  return {
    planId: plan.id,
    dayId: day.id,
    planExerciseId: exercise.id,
  };
}
