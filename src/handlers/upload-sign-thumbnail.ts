import type { RequestHandler } from 'express';

import { signUrl } from '../oss/presign';
import { route, validationEnvelope } from '../routes/http';
import { authorizeStudentPlanExercise, ensureUser, thumbnailOssKey } from './upload-common';
import type { HandlerDeps } from './upload-common';
import { SignThumbnailBodySchema } from './upload-schemas';

export function uploadSignThumbnailHandler(deps: HandlerDeps): RequestHandler {
  return route(async (req, res) => {
    const user = ensureUser(req);
    const body = SignThumbnailBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json(validationEnvelope(body.error));
      return;
    }

    await authorizeStudentPlanExercise(deps, user, body.data.plan_exercise_id);

    const ossKey = thumbnailOssKey(user.id, body.data.plan_exercise_id, body.data.set_index);
    res.status(200).json({
      thumbnail_oss_key: ossKey,
      presigned_url: signUrl(deps.oss, {
        method: 'PUT',
        key: ossKey,
        contentType: body.data.thumbnail_content_type,
      }),
    });
  });
}
