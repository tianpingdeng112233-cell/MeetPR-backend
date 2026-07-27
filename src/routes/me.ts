import bcrypt from 'bcrypt';
import { Router, type Router as ExpressRouter } from 'express';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Logger } from 'pino';

import type { Database } from '../db/types';
import { requireRole } from '../middleware/auth';
import { ChangePasswordBodySchema } from './auth/schemas';
import { route, validationEnvelope } from './http';

const BCRYPT_COST = 10;

// Placeholder left behind on the profile row: display_name is NOT NULL with a
// 1..100 length CHECK, so the name is replaced rather than cleared. Coach-side
// history views keep rendering.
const ANONYMIZED_DISPLAY_NAME = '已注销用户';

// Not a bcrypt digest, so bcrypt.compare against it always resolves false.
const ANONYMIZED_PASSWORD_HASH = '!anonymized';

export interface MeRouterDeps {
  db: Kysely<Database>;
  logger: Logger;
}

/**
 * Anonymized deletion (spec 011 §1, revised 2026-07-27). The users row stays —
 * every training record (sets, readiness, plans, chat) keeps pointing at a now
 * nameless id — while identifying data is wiped and every credential revoked.
 *
 * The phone is set to NULL rather than scrambled: that RELEASES the number so
 * the same person can register again later (a fresh user id, no link back).
 * Postgres treats NULLs as distinct under UNIQUE, so anonymized rows never
 * collide with each other.
 *
 * Returns false when there was nothing to do — an unknown id, or a row already
 * anonymized by an earlier call. The caller still answers 204 (idempotent).
 */
async function anonymizeAccount(trx: Transaction<Database>, userId: string): Promise<boolean> {
  const target = await trx
    .selectFrom('users')
    .select(['id', 'deleted_at'])
    .where('id', '=', userId)
    .forUpdate()
    .executeTakeFirst();
  if (target?.deleted_at !== null) return false;

  await trx
    .updateTable('users')
    .set({
      phone: null,
      apple_user_id: null,
      password_hash: ANONYMIZED_PASSWORD_HASH,
      // Legacy single-slot column (pre-0039) still honoured by the /auth/refresh
      // backfill path — clearing it keeps that door shut too.
      refresh_token_jti: null,
      deleted_at: sql<Date>`now()`,
      updated_at: sql<Date>`now()`,
    })
    .where('id', '=', userId)
    .execute();

  // Revoke every device session (0039); access tokens die at their own expiry.
  await trx
    .updateTable('sessions')
    .set({ revoked_at: sql<Date>`now()` })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .execute();

  // APNs registrations are device identifiers, and a deleted account must stop
  // receiving pushes — drop the rows outright.
  await trx.deleteFrom('device_tokens').where('user_id', '=', userId).execute();

  await trx
    .updateTable('student_profiles')
    .set({ display_name: ANONYMIZED_DISPLAY_NAME, updated_at: sql<Date>`now()` })
    .where('user_id', '=', userId)
    .execute();
  // Coaches cannot reach this endpoint today, but keep the wipe total so a
  // future coach-offboarding wave doesn't leave a name behind.
  await trx
    .updateTable('coach_profiles')
    .set({ display_name: ANONYMIZED_DISPLAY_NAME, updated_at: sql<Date>`now()` })
    .where('user_id', '=', userId)
    .execute();

  // Free text the student typed about themselves. The structured onboarding
  // fields stay: they feed the algorithm engine and carry no identity once the
  // phone and name are gone (spec 011 §1.3).
  await trx
    .updateTable('student_onboarding_profiles')
    .set({ injury_notes: null, note_to_coach: null, updated_at: sql<Date>`now()` })
    .where('user_id', '=', userId)
    .execute();

  return true;
}

export function meRouter(deps: MeRouterDeps): ExpressRouter {
  const router = Router();

  // Account deletion (spec 011 §1, Apple 5.1.1(v)). Students only: coach
  // offboarding semantics (in-flight students, published plan ownership) live
  // outside this wave.
  router.delete(
    '/',
    requireRole('coached_student', 'self_train_student'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const userId = req.user.id;
      const anonymized = await deps.db
        .transaction()
        .execute(async (trx) => anonymizeAccount(trx, userId));

      if (anonymized) {
        deps.logger.info({ userId, role: req.user.role }, 'account_deleted');
      }
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
        await trx
          .updateTable('users')
          .set({
            password_hash: passwordHash,
            // The legacy column doubles as a session-backfill credential in
            // /auth/refresh; clear it so pre-migration tokens die here too.
            refresh_token_jti: null,
            updated_at: sql<Date>`now()`,
          })
          .where('id', '=', userId)
          .execute();
        await trx
          .updateTable('sessions')
          .set({ revoked_at: sql<Date>`now()` })
          .where('user_id', '=', userId)
          .where('revoked_at', 'is', null)
          .execute();
      });
      deps.logger.info({ userId }, 'password_changed');
      res.status(204).end();
    }),
  );

  return router;
}
