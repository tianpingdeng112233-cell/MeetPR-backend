import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';

import { DataType, newDb } from 'pg-mem';
import pino from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import type { Config } from '../src/config';
import { createDb } from '../src/db/kysely';
import type { Database, UserRole } from '../src/db/types';
import {
  getAdminOverview,
  getAdminPlan,
  getAdminUser,
  listAdminExerciseUsage,
  listAdminBindings,
  listAdminPlans,
  listAdminUsers,
} from '../src/handlers/admin';
import type { Kysely } from 'kysely';

const ids = {
  admin: '10000000-0000-4000-8000-000000004410',
  coach: '10000000-0000-4000-8000-000000004411',
  otherCoach: '10000000-0000-4000-8000-000000004412',
  student: '10000000-0000-4000-8000-000000004413',
  selfStudent: '10000000-0000-4000-8000-000000004414',
  acceptedBond: '20000000-0000-4000-8000-000000004411',
  pendingBond: '20000000-0000-4000-8000-000000004412',
  publishedPlan: '30000000-0000-4000-8000-000000004411',
  draftPlan: '30000000-0000-4000-8000-000000004412',
  day: '40000000-0000-4000-8000-000000004411',
  exercise: '50000000-0000-4000-8000-000000004411',
  set: '60000000-0000-4000-8000-000000004411',
  usedExercise: '80000000-0000-4000-8000-000000004411',
  unusedExerciseA: '80000000-0000-4000-8000-000000004412',
  unusedExerciseZ: '80000000-0000-4000-8000-000000004413',
};

const config: Config = {
  NODE_ENV: 'test',
  PORT: 3000,
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  JWT_ACCESS_SECRET: 'access-secret-for-admin-tests-minimum-length-32',
  JWT_REFRESH_SECRET: 'refresh-secret-for-admin-tests-minimum-length-32',
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

interface TestContext {
  app: ReturnType<typeof createApp>;
  db: Kysely<Database>;
  tokens: Record<UserRole, string>;
}

function token(userId: string, role: UserRole): string {
  return jwt.sign({ sub: userId, role }, config.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: '15m',
  });
}

function auth(value: string) {
  return { Authorization: `Bearer ${value}` };
}

function makeContext(): TestContext {
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
  mem.public.none(fs.readFileSync('db/migrations/0044-add-admin-role.sql', 'utf8'));
  mem.public.none(`
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
      rejection_silent BOOLEAN NOT NULL DEFAULT TRUE,
      invite_code_id UUID,
      skip_reason TEXT
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
      block_type TEXT,
      mesocycle_phase TEXT,
      training_max NUMERIC,
      tm_set_at TIMESTAMPTZ,
      published_at TIMESTAMPTZ,
      anchor_weekday SMALLINT,
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
    CREATE TABLE plan_day_shifts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_day_id UUID NOT NULL REFERENCES plan_days(id) ON DELETE CASCADE,
      student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      batch_id UUID NOT NULL,
      shifted_to_date DATE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
      target_value TEXT NOT NULL,
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
      plan_exercise_id UUID REFERENCES plan_exercises(id)
    );
    CREATE TABLE exercises (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      exercise_type TEXT NOT NULL
    );
    INSERT INTO exercises (id, name, exercise_type) VALUES
      ('${ids.usedExercise}', '竞技深蹲', 'main_lift'),
      ('${ids.unusedExerciseA}', 'Alpha Zero', 'accessory'),
      ('${ids.unusedExerciseZ}', 'Zulu Zero', 'main_lift_variation');

    INSERT INTO users (
      id, phone, apple_user_id, password_hash, role, refresh_token_jti, created_at
    ) VALUES
      ('${ids.admin}', '+8613800044200', 'secret-apple-id', 'secret-admin-hash', 'admin', '70000000-0000-4000-8000-000000004410', '2026-07-18T10:00:00Z'),
      ('${ids.coach}', '+8613800044201', NULL, 'secret-coach-hash', 'coach', NULL, '2026-07-17T10:00:00Z'),
      ('${ids.otherCoach}', '+8613800044202', NULL, 'secret-coach-hash', 'coach', NULL, '2026-07-16T10:00:00Z'),
      ('${ids.student}', '+8613800044203', NULL, 'secret-student-hash', 'coached_student', NULL, '2026-07-15T10:00:00Z'),
      ('${ids.selfStudent}', '+8613800044204', NULL, 'secret-self-hash', 'self_train_student', NULL, '2026-07-14T10:00:00Z');

    INSERT INTO coach_profiles (user_id, display_name) VALUES
      ('${ids.coach}', 'Coach One'),
      ('${ids.otherCoach}', 'Coach Two');
    INSERT INTO student_profiles (user_id, display_name) VALUES
      ('${ids.student}', 'Student One'),
      ('${ids.selfStudent}', 'Self Student');

    INSERT INTO bind_requests (
      id, student_id, coach_id, status, submitted_at, responded_at, expired_at
    ) VALUES
      ('${ids.acceptedBond}', '${ids.student}', '${ids.coach}', 'accepted', '2026-07-10T10:00:00Z', '2026-07-11T10:00:00Z', '2026-07-20T10:00:00Z'),
      ('${ids.pendingBond}', '${ids.student}', '${ids.otherCoach}', 'pending', '2026-07-12T10:00:00Z', NULL, '2026-07-22T10:00:00Z');

    INSERT INTO plans (
      id, coach_id, trainee_id, name, start_date, end_date, plan_weeks,
      source, status, created_at, updated_at
    ) VALUES
      ('${ids.publishedPlan}', '${ids.coach}', '${ids.student}', 'Published Block', '2026-07-01', '2026-07-28', 4, 'coach', 'published', '2026-07-01T10:00:00Z', '2026-07-02T10:00:00Z'),
      ('${ids.draftPlan}', NULL, '${ids.selfStudent}', 'Self Draft', '2026-08-01', '2026-08-07', 1, 'algorithm', 'draft', '2026-07-03T10:00:00Z', '2026-07-03T10:00:00Z');
    INSERT INTO plan_days (id, plan_id, day_of_week, week_number, sort_order)
      VALUES ('${ids.day}', '${ids.publishedPlan}', 1, 1, 0);
    INSERT INTO plan_exercises (
      id, plan_day_id, exercise_id, is_main_lift, sort_order, notes
    ) VALUES (
      '${ids.exercise}', '${ids.day}', '${ids.usedExercise}', TRUE, 0, 'Keep tight'
    );
    INSERT INTO plan_sets (
      id, plan_exercise_id, set_number, target_reps, intensity_mode,
      target_value, set_type, rest_seconds, coach_note
    ) VALUES (
      '${ids.set}', '${ids.exercise}', 1, 5, 'weight', '100.00', 'working', 180, 'Top set'
    );
  `);

  const { Pool } = mem.adapters.createPg();
  const db = createDb(new Pool());
  return {
    app: createApp({ config, logger: pino({ level: 'silent' }), db }),
    db,
    tokens: {
      admin: token(ids.admin, 'admin'),
      coach: token(ids.coach, 'coach'),
      coached_student: token(ids.student, 'coached_student'),
      self_train_student: token(ids.selfStudent, 'self_train_student'),
    },
  };
}

async function addDuplicateOtherCoachUsage(ctx: TestContext): Promise<void> {
  const otherPlan = await ctx.db
    .insertInto('plans')
    .values({
      coach_id: ids.otherCoach,
      trainee_id: ids.student,
      name: 'Other Coach Block',
      start_date: '2026-07-01',
      end_date: '2026-07-28',
      plan_weeks: 4,
      source: 'coach',
      status: 'completed',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const otherDay = await ctx.db
    .insertInto('plan_days')
    .values({ plan_id: otherPlan.id, day_of_week: 2, week_number: 1 })
    .returning('id')
    .executeTakeFirstOrThrow();
  await ctx.db
    .insertInto('plan_exercises')
    .values([
      { plan_day_id: otherDay.id, exercise_id: ids.usedExercise },
      { plan_day_id: otherDay.id, exercise_id: ids.usedExercise },
    ])
    .execute();
  // Draft and paused plans must count too — the aggregate has no status filter.
  for (const extra of [
    { coach_id: ids.coach, status: 'draft' as const, name: 'Draft Block' },
    { coach_id: ids.otherCoach, status: 'paused' as const, name: 'Paused Block' },
  ]) {
    const plan = await ctx.db
      .insertInto('plans')
      .values({
        coach_id: extra.coach_id,
        trainee_id: ids.student,
        name: extra.name,
        start_date: '2026-07-01',
        end_date: '2026-07-28',
        plan_weeks: 4,
        source: 'coach',
        status: extra.status,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const day = await ctx.db
      .insertInto('plan_days')
      .values({ plan_id: plan.id, day_of_week: 3, week_number: 1 })
      .returning('id')
      .executeTakeFirstOrThrow();
    await ctx.db
      .insertInto('plan_exercises')
      .values({ plan_day_id: day.id, exercise_id: ids.usedExercise })
      .execute();
  }
}

function expectedDuplicateUsage() {
  return {
    exercises: [
      {
        exercise_id: ids.usedExercise,
        name: '竞技深蹲',
        exercise_type: 'main_lift',
        plan_count: 5,
        coach_count: 2,
      },
      {
        exercise_id: ids.unusedExerciseA,
        name: 'Alpha Zero',
        exercise_type: 'accessory',
        plan_count: 0,
        coach_count: 0,
      },
      {
        exercise_id: ids.unusedExerciseZ,
        name: 'Zulu Zero',
        exercise_type: 'main_lift_variation',
        plan_count: 0,
        coach_count: 0,
      },
    ],
  };
}

function expectNoSensitiveFields(value: unknown): void {
  const json = JSON.stringify(value);
  expect(json).not.toContain('password_hash');
  expect(json).not.toContain('refresh_token_jti');
  expect(json).not.toContain('apple_user_id');
  expect(json).not.toContain('secret-admin-hash');
  expect(json).not.toContain('secret-apple-id');
}

describe('admin read-only API', () => {
  const protectedPaths = [
    '/admin/overview',
    '/admin/exercise-usage',
    '/admin/users',
    `/admin/users/${ids.coach}`,
    '/admin/bindings',
    '/admin/plans',
    `/admin/plans/${ids.publishedPlan}`,
  ];

  it('queries every admin read model from the seeded fixtures without N+1 lookups', async () => {
    const ctx = makeContext();
    const [overview, exerciseUsage, users, user, bindings, plans, plan] = await Promise.all([
      getAdminOverview(ctx.db),
      listAdminExerciseUsage(ctx.db),
      listAdminUsers(ctx.db),
      getAdminUser(ctx.db, ids.coach),
      listAdminBindings(ctx.db),
      listAdminPlans(ctx.db),
      getAdminPlan(ctx.db, ids.publishedPlan),
    ]);

    expect(overview.stats).toEqual({
      coaches: 2,
      coachedStudents: 1,
      selfTrainStudents: 1,
      activeBonds: 1,
      publishedPlans: 1,
    });
    expect(exerciseUsage.exercises).toEqual([
      {
        exercise_id: ids.usedExercise,
        name: '竞技深蹲',
        exercise_type: 'main_lift',
        plan_count: 1,
        coach_count: 1,
      },
      {
        exercise_id: ids.unusedExerciseA,
        name: 'Alpha Zero',
        exercise_type: 'accessory',
        plan_count: 0,
        coach_count: 0,
      },
      {
        exercise_id: ids.unusedExerciseZ,
        name: 'Zulu Zero',
        exercise_type: 'main_lift_variation',
        plan_count: 0,
        coach_count: 0,
      },
    ]);
    expect(users.users).toHaveLength(5);
    expect(user?.relations).toHaveLength(1);
    expect(bindings.bindings).toHaveLength(2);
    expect(plans.plans).toHaveLength(2);
    expect(plan?.days[0]?.exercises[0]?.sets).toHaveLength(1);
    expectNoSensitiveFields({ overview, users, user, bindings, plans, plan });
    await ctx.db.destroy();
  });

  it.each(protectedPaths)('returns 401 for anonymous GET %s', async (path) => {
    const ctx = makeContext();
    const response = await request(ctx.app).get(path);
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'AUTH_INVALID_TOKEN' });
    await ctx.db.destroy();
  });

  it.each(protectedPaths)('returns 403 for coach and student tokens on GET %s', async (path) => {
    const ctx = makeContext();
    for (const role of ['coach', 'coached_student', 'self_train_student'] as const) {
      const response = await request(ctx.app).get(path).set(auth(ctx.tokens[role]));
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });
    }
    await ctx.db.destroy();
  });

  it('rejects a stale admin access token once the DB role is no longer admin', async () => {
    const ctx = makeContext();
    await ctx.db.updateTable('users').set({ role: 'coach' }).where('id', '=', ids.admin).execute();
    const response = await request(ctx.app)
      .get('/admin/exercise-usage')
      .set(auth(ctx.tokens.admin));
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });
    await ctx.db.destroy();
  });

  it('returns overview counts plus recent safe users and published plans', async () => {
    const ctx = makeContext();
    const response = await request(ctx.app).get('/admin/overview').set(auth(ctx.tokens.admin));

    expect(response.status).toBe(200);
    expect(response.body.stats).toEqual({
      coaches: 2,
      coachedStudents: 1,
      selfTrainStudents: 1,
      activeBonds: 1,
      publishedPlans: 1,
    });
    expect(response.body.recentUsers[0]).toMatchObject({
      id: ids.admin,
      displayName: null,
      role: 'admin',
    });
    expect(response.body.recentPlans).toEqual([
      expect.objectContaining({
        id: ids.publishedPlan,
        coachId: ids.coach,
        coachName: 'Coach One',
        traineeId: ids.student,
        studentName: 'Student One',
        publishedAt: '2026-07-02T10:00:00.000Z',
      }),
    ]);
    expectNoSensitiveFields(response.body);
    await ctx.db.destroy();
  });

  it('counts repeated rows while deduplicating coaches in the exercise usage read model', async () => {
    const ctx = makeContext();
    await addDuplicateOtherCoachUsage(ctx);

    expect(await listAdminExerciseUsage(ctx.db)).toEqual(expectedDuplicateUsage());
    await ctx.db.destroy();
  });

  it('returns every exercise with row counts and distinct coach counts', async () => {
    const ctx = makeContext();
    await addDuplicateOtherCoachUsage(ctx);

    const response = await request(ctx.app)
      .get('/admin/exercise-usage')
      .set(auth(ctx.tokens.admin));

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expectedDuplicateUsage());
    await ctx.db.destroy();
  });

  it('returns all users with role-specific accepted-bond relations', async () => {
    const ctx = makeContext();
    const response = await request(ctx.app).get('/admin/users').set(auth(ctx.tokens.admin));

    expect(response.status).toBe(200);
    expect(response.body.users).toContainEqual(
      expect.objectContaining({
        id: ids.coach,
        displayName: 'Coach One',
        relation: { studentCount: 1 },
      }),
    );
    expect(response.body.users).toContainEqual(
      expect.objectContaining({
        id: ids.student,
        relation: { coachId: ids.coach, coachName: 'Coach One' },
      }),
    );
    expect(response.body.users).toContainEqual(
      expect.objectContaining({ id: ids.selfStudent, relation: null }),
    );
    expectNoSensitiveFields(response.body);
    await ctx.db.destroy();
  });

  it('returns one user with accepted relations and associated plan summaries', async () => {
    const ctx = makeContext();
    const response = await request(ctx.app)
      .get(`/admin/users/${ids.coach}`)
      .set(auth(ctx.tokens.admin));

    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({
      id: ids.coach,
      relation: { studentCount: 1 },
    });
    expect(response.body.relations).toEqual([
      {
        userId: ids.student,
        displayName: 'Student One',
        role: 'coached_student',
        bondAcceptedAt: '2026-07-11T10:00:00.000Z',
      },
    ]);
    expect(response.body.plans).toEqual([
      expect.objectContaining({
        id: ids.publishedPlan,
        name: 'Published Block',
        status: 'published',
        weeks: 4,
        coachName: 'Coach One',
        studentName: 'Student One',
      }),
    ]);
    expectNoSensitiveFields(response.body);
    await ctx.db.destroy();
  });

  it('returns all binding requests newest-first with nullable respondedAt', async () => {
    const ctx = makeContext();
    const response = await request(ctx.app).get('/admin/bindings').set(auth(ctx.tokens.admin));

    expect(response.status).toBe(200);
    expect(response.body.bindings).toHaveLength(2);
    expect(response.body.bindings[0]).toEqual({
      id: ids.pendingBond,
      coachId: ids.otherCoach,
      coachName: 'Coach Two',
      studentId: ids.student,
      studentName: 'Student One',
      status: 'pending',
      submittedAt: '2026-07-12T10:00:00.000Z',
      respondedAt: null,
    });
    expectNoSensitiveFields(response.body);
    await ctx.db.destroy();
  });

  it('returns all plans newest-first with camelCase dates and names', async () => {
    const ctx = makeContext();
    const response = await request(ctx.app).get('/admin/plans').set(auth(ctx.tokens.admin));

    expect(response.status).toBe(200);
    expect(response.body.plans).toHaveLength(2);
    expect(response.body.plans[0]).toMatchObject({
      id: ids.draftPlan,
      coachId: null,
      coachName: null,
      traineeId: ids.selfStudent,
      studentName: 'Self Student',
      status: 'draft',
      weeks: 1,
      startDate: '2026-08-01',
      endDate: '2026-08-07',
    });
    expectNoSensitiveFields(response.body);
    await ctx.db.destroy();
  });

  it('reuses the coach plan-detail shape including days, exercises, and sets', async () => {
    const ctx = makeContext();
    const adminResponse = await request(ctx.app)
      .get(`/admin/plans/${ids.publishedPlan}`)
      .set(auth(ctx.tokens.admin));
    const coachResponse = await request(ctx.app)
      .get(`/plans/${ids.publishedPlan}`)
      .set(auth(ctx.tokens.coach));

    expect(adminResponse.status).toBe(200);
    expect(coachResponse.status).toBe(200);
    // Admin detail = coach shape + display-ready exercise_name per exercise
    // (the admin cannot resolve coach-private names via /exercises).
    const stripNames = structuredClone(adminResponse.body) as {
      days: { exercises: { exercise_name?: string }[] }[];
    };
    stripNames.days.forEach((day) => {
      day.exercises.forEach((item) => {
        delete item.exercise_name;
      });
    });
    expect(stripNames).toEqual(coachResponse.body);
    expect(adminResponse.body.days[0].exercises[0].exercise_name).toBe('竞技深蹲');
    expect(coachResponse.body.days[0].exercises[0].exercise_name).toBeUndefined();
    expect(adminResponse.body.days[0].exercises[0].sets[0]).toMatchObject({
      id: ids.set,
      target_value: '100.00',
      rest_seconds: 180,
      coach_note: 'Top set',
    });
    expectNoSensitiveFields(adminResponse.body);
    await ctx.db.destroy();
  });
});
