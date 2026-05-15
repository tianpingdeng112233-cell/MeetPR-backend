import type { RequestHandler } from 'express';

import { route, validationEnvelope } from '../routes/http';
import { authorizeVideoOssKey, ensureUser } from './upload-common';
import type { HandlerDeps } from './upload-common';
import { AbortUploadBodySchema } from './upload-schemas';

export function uploadAbortHandler(deps: HandlerDeps): RequestHandler {
  return route(async (req, res) => {
    const user = ensureUser(req);
    const body = AbortUploadBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json(validationEnvelope(body.error));
      return;
    }

    await authorizeVideoOssKey(deps, user, body.data.oss_key);
    await deps.oss.abortMultipartUpload(body.data.oss_key, body.data.upload_id);
    res.status(204).send();
  });
}
