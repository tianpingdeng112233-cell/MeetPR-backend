import { Router, type Router as ExpressRouter } from 'express';

import type { HandlerDeps } from '../handlers/upload-common';
import { videosFetchHandler } from '../handlers/videos-fetch';

export function videosRouter(deps: HandlerDeps): ExpressRouter {
  const router = Router();
  router.get('/:id/videos', videosFetchHandler(deps));
  return router;
}
