import bcrypt from 'bcrypt';
import { Router, type Router as ExpressRouter } from 'express';
import { sql, type Kysely } from 'kysely';
import type { Logger } from 'pino';

import type { Database } from '../db/types';
import { requireRole } from '../middleware/auth';
import { ChangePasswordBodySchema } from './auth/schemas';
import { route, validationEnvelope } from './http';

const BCRYPT_COST = 10;

export interface MeRouterDeps {
  db: Kysely<Database>;
  logger: Logger;
}

export function meRouter(deps: MeRouterDeps): ExpressRouter {
  const router = Router();

  // Account deletion (spec 011 §1, Apple 5.1.1(v)). Students only: a coach
  // deletion would cascade their plans into bonded students — offboarding
  // semantics live outside this wave.
  router.delete(
    '/',
    requireRole('coached_student', 'self_train_student'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      // The 17 users FKs are all ON DELETE CASCADE — one statement clears
      // every table. Repeat deletes affect 0 rows and stay 204 (idempotent).
      await deps.db.deleteFrom('users').where('id', '=', req.user.id).execute();
      deps.logger.info({ userId: req.user.id, role: req.user.role }, 'account_deleted');
      res.status(204).end();
    }),
  );

  // Password change (spec 011 §2): verify the old, store the new, revoke
  // every refresh token so other devices fall back to the login screen.
  router.put(
    '/password',
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const body = ChangePasswordBodySchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      const user = await deps.db
        .selectFrom('users')
        .select(['id', 'password_hash'])
        .where('id', '=', req.user.id)
        .executeTakeFirst();
      if (!user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const matches = await bcrypt.compare(body.data.old_password, user.password_hash);
      if (!matches) {
        res.status(403).json({ error: 'PASSWORD_MISMATCH' });
        return;
      }

      // Rotate the password and clear the single refresh slot in one write —
      // any outstanding refresh token dies on its jti mismatch (logout idiom).
      const passwordHash = await bcrypt.hash(body.data.new_password, BCRYPT_COST);
      await deps.db
        .updateTable('users')
        .set({
          password_hash: passwordHash,
          refresh_token_jti: null,
          updated_at: sql<Date>`now()`,
        })
        .where('id', '=', req.user.id)
        .execute();
      deps.logger.info({ userId: req.user.id }, 'password_changed');
      res.status(204).end();
    }),
  );

  return router;
}
