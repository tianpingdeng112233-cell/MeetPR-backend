import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import type { Kysely } from 'kysely';
import { DataType, newDb } from 'pg-mem';
import pino from 'pino';

import { createApp } from '../../src/app';
import type { Config } from '../../src/config';
import { createDb } from '../../src/db/kysely';
import type { Database, UserRole } from '../../src/db/types';
import type {
  HeadObjectResult,
  MultipartPart,
  MultipartUpload,
  OSSClient,
  PresignOptions,
} from '../../src/oss/client';

export const videoConfig: Config = {
  NODE_ENV: 'test',
  PORT: 3000,
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  JWT_ACCESS_SECRET: 'access-secret-for-video-tests-minimum-length-32',
  JWT_REFRESH_SECRET: 'refresh-secret-for-video-tests-minimum-length-32',
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_TTL: '30d',
  LOG_LEVEL: 'silent',
  RATE_LIMIT_WINDOW_MS: 60_000,
  RATE_LIMIT_MAX: 10_000,
  CORS_ORIGIN: '*',
  TRUST_PROXY: 0,
  OSS_ACCESS_KEY_ID: 'test-access-key-id',
  OSS_ACCESS_KEY_SECRET: 'test-access-key-secret',
  OSS_BUCKET: 'meetpr-videos-prod',
  OSS_REGION: 'oss-cn-hangzhou',
  OSS_ENDPOINT: 'https://oss-cn-hangzhou.aliyuncs.com',
};

export const coachId = '10000000-0000-4000-8000-000000000001';
export const otherCoachId = '10000000-0000-4000-8000-000000000002';
export const studentId = '10000000-0000-4000-8000-000000000003';
export const otherStudentId = '10000000-0000-4000-8000-000000000004';
export const planExerciseId = '20000000-0000-4000-8000-000000000001';
export const otherCoachPlanExerciseId = '20000000-0000-4000-8000-000000000002';

export function signToken(userId: string, role: UserRole): string {
  return jwt.sign({ sub: userId, role }, videoConfig.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: '15m',
  });
}

export function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

export class FakeOSSClient implements OSSClient {
  initiated: { key: string; contentType: string }[] = [];
  completed: { key: string; uploadId: string; parts: MultipartPart[] }[] = [];
  aborted: { key: string; uploadId: string }[] = [];
  listedPrefixes: string[] = [];
  signatures: { key: string; options: PresignOptions }[] = [];
  uploads: MultipartUpload[] = [];
  heads = new Map<string, HeadObjectResult>();
  completeError: Error | null = null;
  nextUploadId = 'upload-test-1';

  initiateMultipartUpload(key: string, contentType: string): Promise<{ uploadId: string }> {
    this.initiated.push({ key, contentType });
    this.uploads.push({ key, uploadId: this.nextUploadId });
    return Promise.resolve({ uploadId: this.nextUploadId });
  }

  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: MultipartPart[],
  ): Promise<{ etag: string | null }> {
    if (this.completeError) return Promise.reject(this.completeError);
    this.completed.push({ key, uploadId, parts });
    return Promise.resolve({ etag: 'video-final-etag' });
  }

  abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    this.aborted.push({ key, uploadId });
    return Promise.resolve();
  }

  listMultipartUploads(prefix: string): Promise<MultipartUpload[]> {
    this.listedPrefixes.push(prefix);
    return Promise.resolve(this.uploads.filter((upload) => upload.key.startsWith(prefix)));
  }

  headObject(key: string): Promise<HeadObjectResult> {
    const result = this.heads.get(key);
    if (!result) return Promise.reject(new Error(`missing head for ${key}`));
    return Promise.resolve(result);
  }

  signature(key: string, options: PresignOptions): string {
    this.signatures.push({ key, options });
    const url = new URL(`https://meetpr-videos-prod.oss-cn-hangzhou.aliyuncs.com/${key}`);
    url.searchParams.set('method', options.method);
    url.searchParams.set('Expires', String(options.expires ?? 3600));
    if (options.contentType) url.searchParams.set('content-type', options.contentType);
    for (const [name, value] of Object.entries(options.subResource ?? {})) {
      url.searchParams.set(name, String(value));
    }
    return url.toString();
  }
}

export interface VideoTestContext {
  app: ReturnType<typeof createApp>;
  db: Kysely<Database>;
  oss: FakeOSSClient;
  coachToken: string;
  otherCoachToken: string;
  studentToken: string;
  otherStudentToken: string;
}

export function validVideoKey(
  id = studentId,
  exerciseId = planExerciseId,
  setIndex = 0,
  extension = 'mp4',
): string {
  return `students/${id}/sets/${exerciseId}/${String(setIndex)}/30000000-0000-4000-8000-000000000001.${extension}`;
}

export function validThumbnailKey(
  id = studentId,
  exerciseId = planExerciseId,
  setIndex = 0,
): string {
  return `students/${id}/thumbs/${exerciseId}/${String(setIndex)}/30000000-0000-4000-8000-000000000002.jpg`;
}

export async function makeVideoContext(): Promise<VideoTestContext> {
  const mem = newDb();
  mem.public.registerEquivalentType({
    name: 'inet',
    equivalentTo: DataType.text,
    isValid: () => true,
  });
  mem.public.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.uuid,
    impure: true,
    implementation: randomUUID,
  });

  mem.public.none(fs.readFileSync('db/migrations/0001-init-users.sql', 'utf8'));
  mem.public.none(`
    CREATE TABLE exercises (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
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
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      plan_weeks SMALLINT NOT NULL,
      source TEXT NOT NULL,
      source_template_id UUID,
      status TEXT NOT NULL DEFAULT 'draft',
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
  `);
  mem.public.none(fs.readFileSync('db/migrations/0007-init-video-and-consent.sql', 'utf8'));

  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  const db = createDb(pool);

  await db
    .insertInto('users')
    .values([
      { id: coachId, phone: '+8613800002001', password_hash: 'hash', role: 'coach' },
      { id: otherCoachId, phone: '+8613800002002', password_hash: 'hash', role: 'coach' },
      { id: studentId, phone: '+8613800002003', password_hash: 'hash', role: 'coached_student' },
      {
        id: otherStudentId,
        phone: '+8613800002004',
        password_hash: 'hash',
        role: 'coached_student',
      },
    ])
    .execute();

  await db
    .insertInto('exercises')
    .values([
      {
        id: '30000000-0000-4000-8000-000000000101',
        name: 'Squat',
        exercise_type: 'main_lift',
        main_lift_family: 'squat',
        muscle_groups: ['quad'],
        equipment: ['barbell'],
      },
      {
        id: '30000000-0000-4000-8000-000000000102',
        name: 'Bench',
        exercise_type: 'main_lift',
        main_lift_family: 'bench',
        muscle_groups: ['chest'],
        equipment: ['barbell'],
      },
    ])
    .execute();

  await seedPublishedPlan(
    db,
    coachId,
    studentId,
    planExerciseId,
    '30000000-0000-4000-8000-000000000101',
  );
  await seedPublishedPlan(
    db,
    otherCoachId,
    studentId,
    otherCoachPlanExerciseId,
    '30000000-0000-4000-8000-000000000102',
  );

  const oss = new FakeOSSClient();
  return {
    app: createApp({ config: videoConfig, logger: pino({ level: 'silent' }), db, oss }),
    db,
    oss,
    coachToken: signToken(coachId, 'coach'),
    otherCoachToken: signToken(otherCoachId, 'coach'),
    studentToken: signToken(studentId, 'coached_student'),
    otherStudentToken: signToken(otherStudentId, 'coached_student'),
  };
}

async function seedPublishedPlan(
  db: Kysely<Database>,
  coach: string,
  student: string,
  exerciseId: string,
  catalogExerciseId: string,
): Promise<void> {
  const planId = randomUUID();
  const dayId = randomUUID();
  await db
    .insertInto('plans')
    .values({
      id: planId,
      coach_id: coach,
      trainee_id: student,
      name: 'Published plan',
      start_date: '2026-05-01',
      end_date: '2026-05-29',
      plan_weeks: 4,
      source: 'coach',
      source_template_id: null,
      status: 'published',
    })
    .execute();
  await db
    .insertInto('plan_days')
    .values({ id: dayId, plan_id: planId, day_of_week: 1, week_number: 1, sort_order: 0 })
    .execute();
  await db
    .insertInto('plan_exercises')
    .values({ id: exerciseId, plan_day_id: dayId, exercise_id: catalogExerciseId })
    .execute();
}

export async function giveVideoConsent(ctx: VideoTestContext, id = studentId): Promise<void> {
  await ctx.db
    .insertInto('privacy_consents')
    .values({
      user_id: id,
      consent_kind: 'video_visibility_v1',
      agreed_at: new Date('2026-05-15T12:00:00.000Z'),
      user_agent: null,
      ip_address: null,
    })
    .onConflict((oc) => oc.columns(['user_id', 'consent_kind']).doNothing())
    .execute();
}

export async function insertVideo(
  ctx: VideoTestContext,
  overrides: {
    student_id?: string;
    plan_exercise_id?: string;
    set_index?: number;
    oss_key?: string;
    thumbnail_oss_key?: string;
    recorded_at?: Date;
  } = {},
): Promise<void> {
  await ctx.db
    .insertInto('video_attachments')
    .values({
      student_id: overrides.student_id ?? studentId,
      plan_exercise_id: overrides.plan_exercise_id ?? planExerciseId,
      set_index: overrides.set_index ?? 0,
      oss_key: overrides.oss_key ?? validVideoKey(),
      oss_upload_id: 'upload-id',
      duration_seconds: 45.2,
      file_size_bytes: 123_456,
      thumbnail_oss_key: overrides.thumbnail_oss_key ?? validThumbnailKey(),
      recorded_at: overrides.recorded_at ?? new Date('2026-05-15T12:00:00.000Z'),
      uploaded_at: new Date('2026-05-15T12:01:00.000Z'),
      coach_visible_at: new Date('2026-05-15T12:01:00.000Z'),
    })
    .execute();
}
