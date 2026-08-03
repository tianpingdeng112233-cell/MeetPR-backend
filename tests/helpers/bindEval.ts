import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Kysely } from 'kysely';
import { DataType, newDb } from 'pg-mem';
import pino from 'pino';

import { createApp } from '../../src/app';
import type { Config } from '../../src/config';
import { createDb } from '../../src/db/kysely';
import type { Database, PlanKind, UserRole } from '../../src/db/types';

export const config: Config = {
  NODE_ENV: 'test',
  PORT: 3000,
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  JWT_ACCESS_SECRET: 'access-secret-for-bind-eval-tests-000032',
  JWT_REFRESH_SECRET: 'refresh-secret-for-bind-eval-tests-00032',
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

export const ids = {
  coach: '60000000-0000-4000-8000-000000000001',
  otherCoach: '60000000-0000-4000-8000-000000000002',
  // freeStudent: no profile row, no bonds — bind-request bootstrap scenarios.
  freeStudent: '60000000-0000-4000-8000-000000000003',
  // boundStudent: profile row + accepted bond with coach.
  boundStudent: '60000000-0000-4000-8000-000000000004',
  selfTrainStudent: '60000000-0000-4000-8000-000000000005',
  exercise: '70000000-0000-4000-8000-000000000001',
  acceptedBindRequest: '80000000-0000-4000-8000-000000000001',
};

export interface TestContext {
  app: ReturnType<typeof createApp>;
  db: Kysely<Database>;
  coachToken: string;
  otherCoachToken: string;
  freeStudentToken: string;
  boundStudentToken: string;
  selfTrainStudentToken: string;
}

export function signToken(userId: string, role: UserRole): string {
  return jwt.sign({ sub: userId, role, typ: 'access' }, config.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: '15m',
    issuer: 'meetpr-api',
    audience: 'meetpr-client',
  });
}

export function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
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
  mem.public.registerFunction({
    name: 'array_length',
    args: [mem.public.getType(DataType.text).asArray(), DataType.integer],
    returns: DataType.integer,
    implementation: (value: string[] | null, _dimension: number) =>
      value === null ? null : value.length,
  });
}

// NOTE: the real migrations add three partial unique indexes (one active
// personal code / one accepted bond / one active evaluation per pair). They
// are deliberately OMITTED here: pg-mem wrongly serves plain
// `WHERE coach_id = ?` lookups from partial indexes, hiding rows that fall
// outside the index predicate. The invariants are covered by the migration
// tests (0008 / 0011) which run the real SQL files.
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

    CREATE TABLE sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      refresh_token_jti UUID NOT NULL UNIQUE,
      prev_jti UUID,
      prev_jti_valid_until TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at TIMESTAMPTZ
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

    CREATE TABLE invite_codes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      coach_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      max_uses INT,
      used_count INT NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      label TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
      rejection_silent BOOLEAN NOT NULL DEFAULT TRUE,
      invite_code_id UUID REFERENCES invite_codes(id) ON DELETE SET NULL,
      skip_reason TEXT
    );

    CREATE TABLE evaluation_periods (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      coach_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      bind_request_id UUID NOT NULL REFERENCES bind_requests(id) ON DELETE CASCADE,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expected_end_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      completion_type TEXT
    );

    CREATE TABLE student_evaluations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      coach_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      evaluation_period_id UUID REFERENCES evaluation_periods(id) ON DELETE SET NULL,
      overall_assessment TEXT NOT NULL,
      training_plan TEXT NOT NULL,
      words_to_student TEXT,
      first_saved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      UNIQUE (student_id, coach_id)
    );

    CREATE TABLE student_evaluation_versions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      evaluation_id UUID NOT NULL REFERENCES student_evaluations(id) ON DELETE CASCADE,
      overall_assessment TEXT NOT NULL,
      training_plan TEXT NOT NULL,
      words_to_student TEXT,
      notified_student BOOLEAN NOT NULL DEFAULT FALSE,
      saved_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE student_onboarding_profiles (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      unit_preference TEXT,
      gender TEXT,
      birth_date DATE,
      height_cm NUMERIC(5,1),
      weight_kg NUMERIC(5,2),
      training_years SMALLINT,
      squat_stance TEXT,
      deadlift_style TEXT,
      bench_grip TEXT,
      squat_1rm_kg NUMERIC(6,2),
      bench_1rm_kg NUMERIC(6,2),
      deadlift_1rm_kg NUMERIC(6,2),
      training_days TEXT[],
      gym_tier TEXT,
      equipment_overrides TEXT[],
      daily_life_intensity SMALLINT,
      life_stress SMALLINT,
      recovery_speed SMALLINT,
      sleep_hours SMALLINT,
      muscle_groups_to_strengthen TEXT[],
      injury_notes TEXT,
      injury_areas TEXT[],
      is_competing BOOLEAN,
      competition_date DATE,
      target_weight_class TEXT,
      note_to_coach TEXT,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE onboarding_uploads (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      attachment_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, attachment_id)
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
}

export async function makeContext(
  logger = pino({ level: 'silent' }),
  configOverride: Partial<Config> = {},
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
      { id: ids.coach, phone: '+8613800005001', password_hash: 'hash', role: 'coach' },
      { id: ids.otherCoach, phone: '+8613800005002', password_hash: 'hash', role: 'coach' },
      {
        id: ids.freeStudent,
        phone: '+8613800005003',
        password_hash: 'hash',
        role: 'coached_student',
      },
      {
        id: ids.boundStudent,
        phone: '+8613800005004',
        password_hash: 'hash',
        role: 'coached_student',
      },
      {
        id: ids.selfTrainStudent,
        phone: '+8613800005005',
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

  // freeStudent intentionally has NO student_profiles row: the bind request
  // bootstraps it (spec 005 D1).
  await db
    .insertInto('student_profiles')
    .values([{ user_id: ids.boundStudent, display_name: 'Bound Student' }])
    .execute();

  await db
    .insertInto('bind_requests')
    .values({
      id: ids.acceptedBindRequest,
      student_id: ids.boundStudent,
      coach_id: ids.coach,
      status: 'accepted',
      responded_at: new Date('2026-06-01T00:00:00.000Z'),
      expired_at: new Date('2026-06-08T00:00:00.000Z'),
      skip_evaluation: true,
    })
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
    app: createApp({ config: { ...config, ...configOverride }, logger, db }),
    db,
    coachToken: signToken(ids.coach, 'coach'),
    otherCoachToken: signToken(ids.otherCoach, 'coach'),
    freeStudentToken: signToken(ids.freeStudent, 'coached_student'),
    boundStudentToken: signToken(ids.boundStudent, 'coached_student'),
    selfTrainStudentToken: signToken(ids.selfTrainStudent, 'self_train_student'),
  };
}

export interface DraftPlanFixture {
  planId: string;
}

/** Complete draft plan tree (1 day / 1 exercise / 1 set) ready to publish. */
export async function createDraftPlan(
  ctx: TestContext,
  options: { coachId?: string; studentId?: string; kind?: PlanKind; planWeeks?: number } = {},
): Promise<DraftPlanFixture> {
  const coachId = options.coachId ?? ids.coach;
  const studentId = options.studentId ?? ids.boundStudent;
  const kind = options.kind ?? 'regular';
  const planWeeks = options.planWeeks ?? (kind === 'adaptation' ? 1 : 4);

  const plan = await ctx.db
    .insertInto('plans')
    .values({
      coach_id: coachId,
      trainee_id: studentId,
      name: kind === 'adaptation' ? 'Adaptation Week' : 'Regular Block',
      start_date: '2026-06-15',
      end_date: planWeeks === 1 ? '2026-06-21' : '2026-07-12',
      plan_weeks: planWeeks,
      source: 'coach',
      source_template_id: null,
      status: 'draft',
      kind,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();

  const day = await ctx.db
    .insertInto('plan_days')
    .values({ plan_id: plan.id, day_of_week: 1, week_number: 1, sort_order: 0 })
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

  return { planId: plan.id };
}

/** Insert an evaluation period directly; defaults to active (uncompleted). */
export async function createEvaluationPeriod(
  ctx: TestContext,
  options: {
    coachId?: string;
    studentId?: string;
    bindRequestId?: string;
    expectedEndAt?: Date;
    completedAt?: Date | null;
  } = {},
): Promise<{ evaluationId: string }> {
  const row = await ctx.db
    .insertInto('evaluation_periods')
    .values({
      student_id: options.studentId ?? ids.boundStudent,
      coach_id: options.coachId ?? ids.coach,
      bind_request_id: options.bindRequestId ?? ids.acceptedBindRequest,
      expected_end_at: options.expectedEndAt ?? new Date(Date.now() + 7 * 24 * 3600 * 1000),
      completed_at: options.completedAt ?? null,
      completion_type: options.completedAt ? 'coach_completed' : null,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();

  return { evaluationId: row.id };
}
