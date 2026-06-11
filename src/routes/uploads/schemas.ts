import { z } from 'zod';

import { ATTACHMENT_KINDS, type AttachmentKind } from '../../db/types';

const MB = 1024 * 1024;
/** OSS multipart hard limit. */
export const MAX_PART_COUNT = 10_000;

interface KindLimit {
  maxSizeBytes: number;
  contentTypes: readonly string[];
}

/** Per-kind upload gates (spec 004 §技术决策). */
export const KIND_LIMITS: Record<AttachmentKind, KindLimit> = {
  set_video: {
    maxSizeBytes: 200 * MB,
    contentTypes: ['video/mp4', 'video/quicktime'],
  },
  onboarding_video: {
    maxSizeBytes: 200 * MB,
    contentTypes: ['video/mp4', 'video/quicktime'],
  },
  onboarding_doc: {
    maxSizeBytes: 20 * MB,
    contentTypes: ['image/png', 'image/jpeg', 'application/pdf'],
  },
};

/** File extension per whitelisted content type, used to build the oss_key. */
export const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'application/pdf': '.pdf',
};

export const InitiateBodySchema = z
  .object({
    kind: z.enum(ATTACHMENT_KINDS),
    content_type: z.string().min(1),
    size_bytes: z.number().int().positive(),
    part_count: z.number().int().min(1).max(MAX_PART_COUNT),
    filename: z.string().min(1).max(255).optional(),
    // set_video only: links the upload to the student's own set log so the
    // coach-side video wall can resolve it server-side (spec 007).
    set_log_id: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.set_log_id !== undefined && data.kind !== 'set_video') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['set_log_id'],
        message: 'set_log_id is only valid for kind=set_video',
      });
    }
  });

export type InitiateBody = z.infer<typeof InitiateBodySchema>;

export const CompleteBodySchema = z
  .object({
    parts: z
      .array(
        z
          .object({
            part_number: z.number().int().min(1).max(MAX_PART_COUNT),
            etag: z.string().min(1),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_PART_COUNT),
  })
  .strict();

export type CompleteBody = z.infer<typeof CompleteBodySchema>;

/// Abort takes an empty body; unknown/camelCase keys are wire-shape errors.
export const AbortBodySchema = z.object({}).strict();

export const AttachmentIdParamSchema = z.object({
  attachmentId: z.string().uuid(),
});
