import type { RequestHandler } from 'express';

import { route, validationEnvelope } from '../routes/http';
import {
  ensureUser,
  authorizeStudentPlanExercise,
  presignParts,
  videoOssKey,
} from './upload-common';
import type { HandlerDeps } from './upload-common';
import { InitiateUploadBodySchema } from './upload-schemas';

export function uploadInitiateHandler(deps: HandlerDeps): RequestHandler {
  return route(async (req, res) => {
    const user = ensureUser(req);
    const body = InitiateUploadBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json(validationEnvelope(body.error));
      return;
    }

    await authorizeStudentPlanExercise(deps, user, body.data.plan_exercise_id);

    const ossKey = videoOssKey(
      user.id,
      body.data.plan_exercise_id,
      body.data.set_index,
      body.data.content_type,
    );
    const initiated = await deps.oss.initiateMultipartUpload(ossKey, body.data.content_type);
    const partNumbers = Array.from({ length: body.data.part_count }, (_value, index) => index + 1);

    res.status(200).json({
      upload_id: initiated.uploadId,
      oss_key: ossKey,
      presigned_parts: presignParts(deps.oss, ossKey, initiated.uploadId, partNumbers),
    });
  });
}
