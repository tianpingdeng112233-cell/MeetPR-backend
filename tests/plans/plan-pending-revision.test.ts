import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import jwt from 'jsonwebtoken';
import type { Kysely } from 'kysely';
import { DataType, newDb } from 'pg-mem';
import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/app';
import type { Config } from '../../src/config';
import { createDb } from '../../src/db/kysely';
import type { Database, PlanStatus, UserRole } from '../../src/db/types';
import { request } from '../helpers/inMemoryRequest';

const config: Config = {
  NODE_ENV: 'test',
  PORT: 3000,
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  JWT_ACCESS_SECRET: 'access-secret-for-pending-revision-tests-32',
  JWT_REFRESH_SECRET: 'refresh-secret-for-pending-revision-tests-32',
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

const COACH = '10000000-0000-4000-8000-000000000001';
const OTHER_COACH = '10000000-0000-4000-8000-000000000002';
const STUDENT = '10000000-0000-4000-8000-000000000003';

interface TestContext {
  app: ReturnType<typeof createApp>;
  db: Kysely<Database>;
  coachToken: string;
  otherCoachToken: string;
  studentToken: string;
}

function token(userId: string, role: UserRole): string {
  return jwt.sign({ sub: userId, role }, config.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: '15m',
  });
}

function auth(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}` };
}

async function makeContext(): Promise<TestContext> {
  const mem = newDb();
  mem.public.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.uuid,
    impure: true,
    implementation: randomUUID,
  });
  mem.public.none(fs.readFileSync('db/migrations/0001-init-users.sql', 'utf8'));
  mem.public.none(fs.readFileSync('db/migrations/0066-add-user-timezone.sql', 'utf8'));
  mem.public.none(`
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
    CREATE TABLE plan_day_completions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_day_id UUID NOT NULL REFERENCES plan_days(id) ON DELETE CASCADE,
      student_id UUID NOT NULL REFERENCES users(id),
      source TEXT NOT NULL,
      completed_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
    CREATE TABLE plan_sets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_exercise_id UUID NOT NULL REFERENCES plan_exercises(id) ON DELETE CASCADE,
      set_number SMALLINT NOT NULL,
      target_reps SMALLINT NOT NULL,
      target_reps_max SMALLINT,
      intensity_mode TEXT NOT NULL,
      target_value NUMERIC NOT NULL,
      load_mode TEXT,
      pct_anchor TEXT,
      target_pct NUMERIC,
      target_rpe NUMERIC,
      rir_target SMALLINT,
      rpe_low NUMERIC,
      rpe_high NUMERIC,
      weight_low NUMERIC,
      weight_high NUMERIC,
      target_weight NUMERIC,
      set_type TEXT NOT NULL,
      rest_seconds INT,
      coach_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE plan_day_shifts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_day_id UUID NOT NULL REFERENCES plan_days(id) ON DELETE CASCADE,
      student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      batch_id UUID NOT NULL,
      shifted_to_date DATE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  mem.public.none(fs.readFileSync('db/migrations/0068-plan-pending-revisions.sql', 'utf8'));

  const { Pool } = mem.adapters.createPg();
  const db = createDb(new Pool());
  await db
    .insertInto('users')
    .values([
      { id: COACH, phone: '+8613800004401', password_hash: 'hash', role: 'coach' },
      { id: OTHER_COACH, phone: '+8613800004402', password_hash: 'hash', role: 'coach' },
      { id: STUDENT, phone: '+8613800004403', password_hash: 'hash', role: 'coached_student' },
    ])
    .execute();

  return {
    app: createApp({ config, logger: pino({ level: 'silent' }), db }),
    db,
    coachToken: token(COACH, 'coach'),
    otherCoachToken: token(OTHER_COACH, 'coach'),
    studentToken: token(STUDENT, 'coached_student'),
  };
}

async function createPlan(
  ctx: TestContext,
  status: PlanStatus = 'published',
  coachId = COACH,
): Promise<string> {
  const plan = await ctx.db
    .insertInto('plans')
    .values({
      coach_id: coachId,
      trainee_id: STUDENT,
      name: `${status} plan`,
      start_date: '2026-08-24',
      end_date: '2026-09-20',
      plan_weeks: 4,
      source: 'coach',
      status,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return plan.id;
}

async function putRevision(
  ctx: TestContext,
  planId: string,
  body: { version: number; content_hash: string; content: Record<string, unknown> },
  accessToken = ctx.coachToken,
) {
  return request(ctx.app)
    .put(`/plans/${planId}/pending-revision`)
    .set(auth(accessToken))
    .send(body);
}

describe('plan pending revision', () => {
  it('upserts last-writer-wins and GET returns opaque content unchanged', async () => {
    const ctx = await makeContext();
    const planId = await createPlan(ctx);
    const firstContent = { weeks: [{ day: 1, exercises: ['squat'] }], metadata: { local: true } };
    const first = await putRevision(ctx, planId, {
      version: 1,
      content_hash: 'fnv1a32:first',
      content: firstContent,
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      plan_id: planId,
      version: 1,
      content_hash: 'fnv1a32:first',
      saved_at: expect.any(String),
    });
    expect(first.body).not.toHaveProperty('content');

    const fetched = await request(ctx.app)
      .get(`/plans/${planId}/pending-revision`)
      .set(auth(ctx.coachToken));
    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual({
      plan_id: planId,
      version: 1,
      content_hash: 'fnv1a32:first',
      content: firstContent,
      saved_at: first.body.saved_at,
    });

    const secondContent = { weeks: [], arbitrary: { nested: [true, null, 3] } };
    const second = await putRevision(ctx, planId, {
      version: 2,
      content_hash: 'fnv1a32:second',
      content: secondContent,
    });
    expect(second.status).toBe(200);
    expect(new Date(second.body.saved_at).getTime()).toBeGreaterThanOrEqual(
      new Date(first.body.saved_at).getTime(),
    );

    const overwritten = await request(ctx.app)
      .get(`/plans/${planId}/pending-revision`)
      .set(auth(ctx.coachToken));
    expect(overwritten.body).toMatchObject({
      version: 2,
      content_hash: 'fnv1a32:second',
      content: secondContent,
      saved_at: second.body.saved_at,
    });
  });

  it('hides revisions from other coaches and forbids student access', async () => {
    const ctx = await makeContext();
    const planId = await createPlan(ctx);
    await putRevision(ctx, planId, {
      version: 1,
      content_hash: 'fnv1a32:owned',
      content: {},
    });

    for (const method of ['put', 'get', 'delete'] as const) {
      const otherCoachRequest = request(ctx.app)
        [method](`/plans/${planId}/pending-revision`)
        .set(auth(ctx.otherCoachToken));
      const otherCoach =
        method === 'put'
          ? await otherCoachRequest.send({ version: 1, content_hash: 'hash', content: {} })
          : await otherCoachRequest;
      expect(otherCoach.status).toBe(404);
      expect(otherCoach.body).toEqual({ error: 'PLAN_NOT_FOUND' });

      const studentRequest = request(ctx.app)
        [method](`/plans/${planId}/pending-revision`)
        .set(auth(ctx.studentToken));
      const student =
        method === 'put'
          ? await studentRequest.send({ version: 1, content_hash: 'hash', content: {} })
          : await studentRequest;
      expect(student.status).toBe(403);
      expect(student.body).toEqual({ error: 'AUTHORIZATION_FORBIDDEN' });
    }
  });

  it('allows draft PUT and rejects completed or paused plans', async () => {
    const ctx = await makeContext();
    const draftId = await createPlan(ctx, 'draft');
    const completedId = await createPlan(ctx, 'completed');
    const pausedId = await createPlan(ctx, 'paused');
    const body = { version: 1, content_hash: 'hash', content: {} };

    expect((await putRevision(ctx, draftId, body)).status).toBe(200);
    for (const planId of [completedId, pausedId]) {
      const response = await putRevision(ctx, planId, body);
      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: 'PLAN_NOT_EDITABLE' });
    }
  });

  it('accepts exactly 1 MiB and rejects larger serialized content', async () => {
    const ctx = await makeContext();
    const planId = await createPlan(ctx);
    const emptyContentSize = Buffer.byteLength(JSON.stringify({ value: '' }), 'utf8');
    const boundary = await putRevision(ctx, planId, {
      version: 1,
      content_hash: 'boundary',
      content: { value: 'x'.repeat(1024 * 1024 - emptyContentSize) },
    });
    expect(boundary.status).toBe(200);

    for (const contentLength of [1024 * 1024, 2 * 1024 * 1024]) {
      const response = await putRevision(ctx, planId, {
        version: 1,
        content_hash: 'hash',
        content: { value: 'x'.repeat(contentLength) },
      });

      expect(response.status).toBe(413);
      expect(response.body).toEqual({ error: 'PAYLOAD_TOO_LARGE' });
    }
  });

  it('DELETE is idempotent and plan deletion cascades its revision', async () => {
    const ctx = await makeContext();
    const planId = await createPlan(ctx);
    await putRevision(ctx, planId, { version: 1, content_hash: 'hash', content: {} });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await request(ctx.app)
        .delete(`/plans/${planId}/pending-revision`)
        .set(auth(ctx.coachToken));
      expect(response.status).toBe(204);
    }
    const missing = await request(ctx.app)
      .get(`/plans/${planId}/pending-revision`)
      .set(auth(ctx.coachToken));
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'PENDING_REVISION_NOT_FOUND' });

    await putRevision(ctx, planId, { version: 1, content_hash: 'hash', content: {} });
    await ctx.db.deleteFrom('plans').where('id', '=', planId).execute();
    expect(
      await ctx.db
        .selectFrom('plan_pending_revisions')
        .select('plan_id')
        .where('plan_id', '=', planId)
        .executeTakeFirst(),
    ).toBeUndefined();
  });

  it('adds saved-at only to coach plan list and detail responses', async () => {
    const ctx = await makeContext();
    const withRevisionId = await createPlan(ctx);
    const withoutRevisionId = await createPlan(ctx);
    const put = await putRevision(ctx, withRevisionId, {
      version: 1,
      content_hash: 'hash',
      content: {},
    });

    const coachList = await request(ctx.app)
      .get(`/students/${STUDENT}/plans`)
      .set(auth(ctx.coachToken));
    expect(coachList.status).toBe(200);
    const coachPlans = coachList.body.plans as {
      id: string;
      pending_revision_saved_at: string | null;
    }[];
    expect(coachPlans.find((plan) => plan.id === withRevisionId)?.pending_revision_saved_at).toBe(
      put.body.saved_at,
    );
    expect(
      coachPlans.find((plan) => plan.id === withoutRevisionId)?.pending_revision_saved_at,
    ).toBeNull();

    const studentList = await request(ctx.app)
      .get(`/students/${STUDENT}/plans`)
      .set(auth(ctx.studentToken));
    expect(studentList.status).toBe(200);
    for (const plan of studentList.body.plans as Record<string, unknown>[]) {
      expect(plan).not.toHaveProperty('pending_revision_saved_at');
    }

    const coachDetail = await request(ctx.app)
      .get(`/plans/${withRevisionId}`)
      .set(auth(ctx.coachToken));
    expect(coachDetail.status).toBe(200);
    expect(coachDetail.body.pending_revision_saved_at).toBe(put.body.saved_at);

    const studentDetail = await request(ctx.app)
      .get(`/plans/${withRevisionId}`)
      .set(auth(ctx.studentToken));
    expect(studentDetail.status).toBe(200);
    expect(studentDetail.body).not.toHaveProperty('pending_revision_saved_at');
  });
});
