import { Router, type Router as ExpressRouter } from 'express';
import type { Kysely } from 'kysely';

import { privacyConsentHandler } from '../handlers/privacy-consent';
import type { Database } from '../db/types';

interface PrivacyRouterDeps {
  db: Kysely<Database>;
}

export function privacyRouter(deps: PrivacyRouterDeps): ExpressRouter {
  const router = Router();
  router.post('/consent', privacyConsentHandler(deps));
  return router;
}
