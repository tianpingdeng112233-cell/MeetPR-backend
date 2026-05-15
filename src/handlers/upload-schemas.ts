import { z } from 'zod';

const UuidSchema = z.string().uuid();
const SetIndexSchema = z.number().int().min(0).max(99);
const UploadIdSchema = z.string().min(1);
const OssKeySchema = z.string().min(1);
const PartNumberSchema = z.number().int().min(1).max(10_000);

export const InitiateUploadBodySchema = z.object({
  plan_exercise_id: UuidSchema,
  set_index: SetIndexSchema,
  content_type: z.enum(['video/mp4', 'video/quicktime']),
  part_count: z.number().int().min(1).max(10_000),
});

export const SignThumbnailBodySchema = z.object({
  plan_exercise_id: UuidSchema,
  set_index: SetIndexSchema,
  thumbnail_content_type: z.literal('image/jpeg'),
});

export const SignPartsBodySchema = z.object({
  upload_id: UploadIdSchema,
  oss_key: OssKeySchema,
  part_numbers: z.array(PartNumberSchema).min(1).max(10_000),
});

export const CompleteUploadBodySchema = z.object({
  upload_id: UploadIdSchema,
  oss_key: OssKeySchema,
  parts: z
    .array(
      z.object({
        part_number: PartNumberSchema,
        etag: z.string().min(1),
      }),
    )
    .min(1)
    .max(10_000),
  duration_seconds: z.number().min(0.1).max(121),
  thumbnail_oss_key: OssKeySchema,
  thumbnail_etag: z.string().min(1),
  recorded_at: z.string().datetime(),
});

export const AbortUploadBodySchema = z.object({
  upload_id: UploadIdSchema,
  oss_key: OssKeySchema,
});

export const PrivacyConsentBodySchema = z.object({
  kind: z.literal('video_visibility_v1'),
});

export const StudentVideosParamSchema = z.object({
  id: UuidSchema,
});
