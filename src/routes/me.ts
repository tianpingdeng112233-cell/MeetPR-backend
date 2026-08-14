import bcrypt from 'bcrypt';
import { Router, type Router as ExpressRouter } from 'express';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';

import type { Config } from '../config';
import type { Database } from '../db/types';
import { requireRole } from '../middleware/auth';
import { appleCredentials, revokeAppleRefreshToken } from '../services/apple';
import { storePasswordAndRevokeSessions } from '../services/password';
import { BCRYPT_COST } from './auth/constants';
import { ChangePasswordBodySchema } from './auth/schemas';
import { route, validationEnvelope } from './http';

export interface MeRouterDeps {
  config: Pick<Config, 'APPLE_CLIENT_ID' | 'SIWA_KEY_ID' | 'SIWA_TEAM_ID' | 'SIWA_PRIVATE_KEY'>;
  db: Kysely<Database>;
  logger: Logger;
  fetch?: typeof fetch;
}

export function meRouter(deps: MeRouterDeps): ExpressRouter {
  const router = Router();

  router.get(
    '/',
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const user = await deps.db
        .selectFrom('users')
        .select(['id', 'phone', 'email', 'role', 'created_at'])
        .where('id', '=', req.user.id)
        .executeTakeFirst();
      if (!user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      res.status(200).json({
        user: {
          id: user.id,
          phone: user.phone,
          email: user.email,
          role: user.role,
          createdAt: user.created_at.toISOString(),
        },
      });
    }),
  );

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

      const appleIdentity = await deps.db
        .selectFrom('user_identities')
        .select('apple_refresh_token')
        .where('user_id', '=', req.user.id)
        .where('provider', '=', 'apple')
        .executeTakeFirst();
      if (appleIdentity?.apple_refresh_token) {
        const credentials = appleCredentials(deps.config);
        if (credentials === null) {
          deps.logger.warn({ userId: req.user.id }, 'apple_token_revoke_not_configured');
        } else {
          try {
            await revokeAppleRefreshToken(
              credentials,
              appleIdentity.apple_refresh_token,
              deps.fetch,
            );
          } catch (error: unknown) {
            deps.logger.error({ err: error, userId: req.user.id }, 'apple_token_revoke_failed');
          }
        }
      }

      // The users FKs are all ON DELETE CASCADE — one statement clears
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

      // Rotate the password and revoke every device session atomically.
      const passwordHash = await bcrypt.hash(body.data.new_password, BCRYPT_COST);
      const userId = req.user.id;
      await deps.db.transaction().execute(async (trx) => {
        await storePasswordAndRevokeSessions(trx, userId, passwordHash);
      });
      deps.logger.info({ userId }, 'password_changed');
      res.status(204).end();
    }),
  );

  return router;
}
