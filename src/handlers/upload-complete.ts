import type { RequestHandler } from 'express';

import { parseThumbnailOssKey } from '../helpers/oss-key-parse';
import { route, validationEnvelope } from '../routes/http';
import { ApiError } from '../utils/apiError';
import {
  authorizeVideoOssKey,
  ensureUser,
  ensureVideoConsent,
  MAX_VIDEO_FILE_SIZE_BYTES,
  toVideoAttachmentWithURLs,
} from './upload-common';
import type { HandlerDeps } from './upload-common';
import { CompleteUploadBodySchema } from './upload-schemas';

function normalizeEtag(etag: string): string {
  return etag.replace(/^"|"$/g, '');
}

export function uploadCompleteHandler(deps: HandlerDeps): RequestHandler {
  return route(async (req, res) => {
    const user = ensureUser(req);
    const body = CompleteUploadBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json(validationEnvelope(body.error));
      return;
    }

    const videoKey = await authorizeVideoOssKey(deps, user, body.data.oss_key);
    const thumbnailKey = parseThumbnailOssKey(body.data.thumbnail_oss_key);
    if (
      thumbnailKey.studentId !== user.id ||
      thumbnailKey.planExerciseId !== videoKey.planExerciseId ||
      thumbnailKey.setIndex !== videoKey.setIndex
    ) {
      throw new ApiError('UPLOAD_OSS_KEY_OWNERSHIP', 403);
    }

    const uploads = await deps.oss.listMultipartUploads(body.data.oss_key);
    const matchingUpload = uploads.find(
      (upload) => upload.key === body.data.oss_key && upload.uploadId === body.data.upload_id,
    );
    if (!matchingUpload) throw new ApiError('UPLOAD_NOT_FOUND', 400);

    try {
      await deps.oss.completeMultipartUpload(
        body.data.oss_key,
        body.data.upload_id,
        body.data.parts.map((part) => ({
          partNumber: part.part_number,
          etag: part.etag,
        })),
      );
    } catch {
      throw new ApiError('UPLOAD_INVALID_PARTS', 400);
    }

    const videoHead = await deps.oss.headObject(body.data.oss_key);
    if (videoHead.contentLength > MAX_VIDEO_FILE_SIZE_BYTES) {
      throw new ApiError('UPLOAD_TOO_LARGE', 400);
    }

    let thumbnailHead;
    try {
      thumbnailHead = await deps.oss.headObject(body.data.thumbnail_oss_key);
    } catch {
      throw new ApiError('UPLOAD_INVALID_THUMBNAIL', 400);
    }

    if (
      !thumbnailHead.etag ||
      normalizeEtag(thumbnailHead.etag) !== normalizeEtag(body.data.thumbnail_etag)
    ) {
      throw new ApiError('UPLOAD_INVALID_THUMBNAIL', 400);
    }

    await ensureVideoConsent(deps.db, user.id);

    const uploadedAt = new Date();
    const row = await deps.db
      .insertInto('video_attachments')
      .values({
        student_id: user.id,
        plan_exercise_id: videoKey.planExerciseId,
        set_index: videoKey.setIndex,
        oss_key: body.data.oss_key,
        oss_upload_id: body.data.upload_id,
        duration_seconds: body.data.duration_seconds,
        file_size_bytes: videoHead.contentLength,
        thumbnail_oss_key: body.data.thumbnail_oss_key,
        recorded_at: new Date(body.data.recorded_at),
        uploaded_at: uploadedAt,
        coach_visible_at: uploadedAt,
      })
      .onConflict((oc) =>
        oc.columns(['student_id', 'plan_exercise_id', 'set_index']).doUpdateSet({
          oss_key: body.data.oss_key,
          oss_upload_id: body.data.upload_id,
          duration_seconds: body.data.duration_seconds,
          file_size_bytes: videoHead.contentLength,
          thumbnail_oss_key: body.data.thumbnail_oss_key,
          recorded_at: new Date(body.data.recorded_at),
          uploaded_at: uploadedAt,
          coach_visible_at: uploadedAt,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    res.status(201).json(toVideoAttachmentWithURLs(row, deps.oss));
  });
}
