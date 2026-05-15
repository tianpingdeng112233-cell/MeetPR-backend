import { Router, type Router as ExpressRouter } from 'express';

import type { HandlerDeps } from '../handlers/upload-common';
import { uploadAbortHandler } from '../handlers/upload-abort';
import { uploadCompleteHandler } from '../handlers/upload-complete';
import { uploadInitiateHandler } from '../handlers/upload-initiate';
import { uploadSignPartsHandler } from '../handlers/upload-sign-parts';
import { uploadSignThumbnailHandler } from '../handlers/upload-sign-thumbnail';

export function uploadRouter(deps: HandlerDeps): ExpressRouter {
  const router = Router();

  router.post('/initiate', uploadInitiateHandler(deps));
  router.post('/sign-thumbnail', uploadSignThumbnailHandler(deps));
  router.post('/sign-parts', uploadSignPartsHandler(deps));
  router.post('/complete', uploadCompleteHandler(deps));
  router.post('/abort', uploadAbortHandler(deps));

  return router;
}
