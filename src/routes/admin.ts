import { Router, type Router as ExpressRouter } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { Database } from '../db/types';
import {
  getAdminOverview,
  getAdminPlan,
  getAdminUser,
  listAdminBindings,
  listAdminPlans,
  listAdminUsers,
} from '../handlers/admin';
import { requireRole } from '../middleware/auth';
import { route, validationEnvelope } from './http';

interface AdminRouterDeps {
  db: Kysely<Database>;
}

const IdParamSchema = z.object({ id: z.string().uuid() });

export function adminRouter(deps: AdminRouterDeps): ExpressRouter {
  const router = Router();

  router.use(requireRole('admin'));
  // Access tokens are stateless (≤ JWT_ACCESS_TTL residual after any role
  // change, consistent app-wide). The admin surface additionally re-verifies
  // the live DB role so a token minted before a demotion/removal — or with a
  // stale admin claim — can never read platform-wide data.
  router.use((req, res, next) => {
    void (async () => {
      const userId = req.user?.id;
      const row = userId
        ? await deps.db
            .selectFrom('users')
            .select('role')
            .where('id', '=', userId)
            .executeTakeFirst()
        : undefined;
      if (row?.role !== 'admin') {
        res.status(403).json({ error: 'AUTHORIZATION_FORBIDDEN' });
        return;
      }
      next();
    })().catch(next);
  });

  router.get(
    '/overview',
    route(async (_req, res) => {
      res.status(200).json(await getAdminOverview(deps.db));
    }),
  );

  router.get(
    '/users',
    route(async (_req, res) => {
      res.status(200).json(await listAdminUsers(deps.db));
    }),
  );

  router.get(
    '/users/:id',
    route(async (req, res) => {
      const params = IdParamSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }
      const result = await getAdminUser(deps.db, params.data.id);
      if (!result) {
        res.status(404).json({ error: 'ADMIN_USER_NOT_FOUND' });
        return;
      }
      res.status(200).json(result);
    }),
  );

  router.get(
    '/bindings',
    route(async (_req, res) => {
      res.status(200).json(await listAdminBindings(deps.db));
    }),
  );

  router.get(
    '/plans',
    route(async (_req, res) => {
      res.status(200).json(await listAdminPlans(deps.db));
    }),
  );

  router.get(
    '/plans/:id',
    route(async (req, res) => {
      const params = IdParamSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }
      const plan = await getAdminPlan(deps.db, params.data.id);
      if (!plan) {
        res.status(404).json({ error: 'ADMIN_PLAN_NOT_FOUND' });
        return;
      }
      res.status(200).json(plan);
    }),
  );

  return router;
}
