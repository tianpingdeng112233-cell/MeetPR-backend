import type { RequestHandler } from 'express';

import { route, validationEnvelope } from '../routes/http';
import { authorizeVideoOssKey, ensureUser, presignParts } from './upload-common';
import type { HandlerDeps } from './upload-common';
import { SignPartsBodySchema } from './upload-schemas';

export function uploadSignPartsHandler(deps: HandlerDeps): RequestHandler {
  return route(async (req, res) => {
    const user = ensureUser(req);
    const body = SignPartsBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json(validationEnvelope(body.error));
      return;
    }

    await authorizeVideoOssKey(deps, user, body.data.oss_key);

    res.status(200).json({
      presigned_parts: presignParts(
        deps.oss,
        body.data.oss_key,
        body.data.upload_id,
        body.data.part_numbers,
      ),
    });
  });
}
