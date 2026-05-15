import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import type { Kysely, Selectable } from 'kysely';

import { publishedPlanExerciseForStudent } from '../db/planOwnership';
import type { Database, UserRole, VideoAttachmentsTable } from '../db/types';
import { parseVideoOssKey, type ParsedVideoOssKey } from '../helpers/oss-key-parse';
import type { OSSClient } from '../oss/client';
import { signUrl } from '../oss/presign';
import { ApiError } from '../utils/apiError';

export const VIDEO_VISIBILITY_CONSENT_KIND = 'video_visibility_v1';
export const MAX_VIDEO_FILE_SIZE_BYTES = 1_073_741_824;

export interface HandlerDeps {
  db: Kysely<Database>;
  oss: OSSClient;
}

export interface AuthenticatedUser {
  id: string;
  role: UserRole;
}

export interface PresignedPart {
  part_number: number;
  presigned_url: string;
}

export interface VideoAttachmentWithURLs {
  id: string;
  student_id: string;
  plan_exercise_id: string;
  set_index: number;
  oss_key: string;
  duration_seconds: string;
  file_size_bytes: number;
  thumbnail_oss_key: string;
  recorded_at: string;
  uploaded_at: string;
  coach_visible_at: string;
  video_url: string;
  thumbnail_url: string;
}

export function ensureUser(req: Request): AuthenticatedUser {
  if (!req.user) throw new ApiError('AUTH_INVALID_TOKEN', 401);
  return req.user;
}

export function ensureStudentRole(user: AuthenticatedUser): void {
  if (user.role !== 'coached_student' && user.role !== 'self_train_student') {
    throw new ApiError('AUTHORIZATION_FORBIDDEN', 403);
  }
}

export async function ensureVideoConsent(db: Kysely<Database>, userId: string): Promise<void> {
  const row = await db
    .selectFrom('privacy_consents')
    .select('id')
    .where('user_id', '=', userId)
    .where('consent_kind', '=', VIDEO_VISIBILITY_CONSENT_KIND)
    .executeTakeFirst();

  if (!row) throw new ApiError('CONSENT_MISSING', 409);
}

export async function ensurePublishedPlanExercise(
  db: Kysely<Database>,
  planExerciseId: string,
  studentId: string,
): Promise<void> {
  const ownsPlanExercise = await publishedPlanExerciseForStudent(db, planExerciseId, studentId);
  if (!ownsPlanExercise) throw new ApiError('UPLOAD_PLAN_EXERCISE_NOT_PUBLISHED', 400);
}

export async function authorizeStudentPlanExercise(
  deps: Pick<HandlerDeps, 'db'>,
  user: AuthenticatedUser,
  planExerciseId: string,
): Promise<void> {
  ensureStudentRole(user);
  await ensureVideoConsent(deps.db, user.id);
  await ensurePublishedPlanExercise(deps.db, planExerciseId, user.id);
}

export async function authorizeVideoOssKey(
  deps: Pick<HandlerDeps, 'db'>,
  user: AuthenticatedUser,
  ossKey: string,
): Promise<ParsedVideoOssKey> {
  ensureStudentRole(user);
  const parsed = parseVideoOssKey(ossKey);
  if (parsed.studentId !== user.id) throw new ApiError('UPLOAD_OSS_KEY_OWNERSHIP', 403);
  await ensureVideoConsent(deps.db, user.id);
  await ensurePublishedPlanExercise(deps.db, parsed.planExerciseId, user.id);
  return parsed;
}

export function videoOssKey(
  studentId: string,
  planExerciseId: string,
  setIndex: number,
  contentType: 'video/mp4' | 'video/quicktime',
): string {
  const extension = contentType === 'video/quicktime' ? 'mov' : 'mp4';
  return `students/${studentId}/sets/${planExerciseId}/${String(setIndex)}/${randomUUID()}.${extension}`;
}

export function thumbnailOssKey(
  studentId: string,
  planExerciseId: string,
  setIndex: number,
): string {
  return `students/${studentId}/thumbs/${planExerciseId}/${String(setIndex)}/${randomUUID()}.jpg`;
}

export function presignParts(
  oss: OSSClient,
  ossKey: string,
  uploadId: string,
  partNumbers: number[],
): PresignedPart[] {
  return partNumbers.map((partNumber) => ({
    part_number: partNumber,
    presigned_url: signUrl(oss, {
      method: 'PUT',
      key: ossKey,
      subResource: { partNumber, uploadId },
    }),
  }));
}

function iso(date: Date): string {
  return date.toISOString();
}

export function toVideoAttachmentWithURLs(
  row: Selectable<VideoAttachmentsTable>,
  oss: OSSClient,
): VideoAttachmentWithURLs {
  return {
    id: row.id,
    student_id: row.student_id,
    plan_exercise_id: row.plan_exercise_id,
    set_index: row.set_index,
    oss_key: row.oss_key,
    duration_seconds: Number(row.duration_seconds).toFixed(2),
    file_size_bytes: Number(row.file_size_bytes),
    thumbnail_oss_key: row.thumbnail_oss_key,
    recorded_at: iso(row.recorded_at),
    uploaded_at: iso(row.uploaded_at),
    coach_visible_at: iso(row.coach_visible_at),
    video_url: signUrl(oss, { method: 'GET', key: row.oss_key }),
    thumbnail_url: signUrl(oss, { method: 'GET', key: row.thumbnail_oss_key }),
  };
}
