import bcrypt from 'bcrypt';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

import { Router, type Router as ExpressRouter } from 'express';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { z } from 'zod';

import type { Config } from '../../config';
import type { Database } from '../../db/types';
import type { Logger } from '../../logger';
import {
  createForgotEmailRateLimit,
  createForgotIpRateLimit,
  createResetEmailRateLimit,
} from '../../middleware/rateLimit';
import { sendPasswordResetEmail } from '../../services/mail';
import { storePasswordAndRevokeSessions } from '../../services/password';
import { route, validationEnvelope } from '../http';
import { BCRYPT_COST } from './constants';
import { PasswordSchema } from './schemas';

const RESET_CODE_TTL_MS = 10 * 60 * 1000;
const RESET_CODE_MAX_ATTEMPTS = 5;
const EmailSchema = z.string().trim().email().max(320);
const ForgotBodySchema = z.object({ email: EmailSchema }).strict();
const ResetBodySchema = z
  .object({
    email: EmailSchema,
    code: z.string().regex(/^\d{6}$/),
    newPassword: PasswordSchema,
  })
  .strict();

type EmailRecoveryConfig = Pick<Config, 'RESEND_API_KEY' | 'EMAIL_FROM'>;

interface EmailRecoveryRouterDeps {
  config: EmailRecoveryConfig;
  db: Kysely<Database>;
  logger: Logger;
  fetch?: typeof fetch;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function codeHash(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

function hashesEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function invalidResetCode(res: Parameters<Parameters<typeof route>[0]>[1]): void {
  res.status(401).json({ error: 'AUTH_INVALID_RESET_CODE' });
}

export function emailRecoveryRouter(deps: EmailRecoveryRouterDeps): ExpressRouter {
  const router = Router();

  router.post(
    '/forgot',
    createForgotIpRateLimit(),
    createForgotEmailRateLimit(),
    route(async (req, res) => {
      const body = ForgotBodySchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      const email = normalizeEmail(body.data.email);
      const issued = await deps.db.transaction().execute(async (trx) => {
        // The same query/transaction shape is used for a missing account and
        // a non-email identity. Locking the user also serializes issuance so
        // two concurrent requests cannot leave two active codes.
        const identity = await trx
          .selectFrom('user_identities as identity')
          .innerJoin('users as user', 'user.id', 'identity.user_id')
          .select('identity.user_id')
          .where('identity.provider', '=', 'email')
          .where('identity.provider_uid', '=', email)
          .forUpdate()
          .executeTakeFirst();
        if (!identity) return null;

        const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
        await trx
          .updateTable('password_reset_codes')
          .set({ used_at: sql<Date>`now()` })
          .where('user_id', '=', identity.user_id)
          .where('used_at', 'is', null)
          .execute();
        await trx
          .insertInto('password_reset_codes')
          .values({
            user_id: identity.user_id,
            code_hash: codeHash(code),
            expires_at: new Date(Date.now() + RESET_CODE_TTL_MS),
          })
          .execute();
        return { userId: identity.user_id, code };
      });
      if (issued !== null) {
        if (deps.config.RESEND_API_KEY === undefined || deps.config.EMAIL_FROM === undefined) {
          deps.logger.warn({ userId: issued.userId }, 'password_reset_email_not_configured');
        } else {
          // Deliberately not awaited: the 204 must not depend on mail-delivery
          // latency, or a slow/failing Resend call (up to its 5s timeout)
          // becomes an account-existence timing oracle on this public endpoint.
          const issuedUserId = issued.userId;
          void sendPasswordResetEmail(
            {
              apiKey: deps.config.RESEND_API_KEY,
              from: deps.config.EMAIL_FROM,
              to: email,
              code: issued.code,
            },
            deps.fetch,
          ).catch((error: unknown) => {
            deps.logger.error({ err: error, userId: issuedUserId }, 'password_reset_email_failed');
          });
        }
      }
      res.status(204).end();
    }),
  );

  router.post(
    '/reset',
    createResetEmailRateLimit(),
    route(async (req, res) => {
      const body = ResetBodySchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      const email = normalizeEmail(body.data.email);
      // Hash before opening the transaction so bcrypt never extends the row
      // lock. Doing it for invalid codes too avoids an account-existence timing
      // split on this public endpoint.
      const passwordHash = await bcrypt.hash(body.data.newPassword, BCRYPT_COST);
      const resetUserId = await deps.db.transaction().execute(async (trx) => {
        const candidate = await trx
          .selectFrom('password_reset_codes as reset_code')
          .innerJoin('user_identities as identity', 'identity.user_id', 'reset_code.user_id')
          .select([
            'reset_code.id',
            'reset_code.user_id',
            'reset_code.code_hash',
            'reset_code.attempts',
          ])
          .where('identity.provider', '=', 'email')
          .where('identity.provider_uid', '=', email)
          .where('reset_code.used_at', 'is', null)
          .where('reset_code.expires_at', '>', sql<Date>`now()`)
          .where('reset_code.attempts', '<', RESET_CODE_MAX_ATTEMPTS)
          .orderBy('reset_code.created_at', 'desc')
          .orderBy('reset_code.id', 'desc')
          .forUpdate()
          .executeTakeFirst();
        if (!candidate) return null;

        const attempts = candidate.attempts + 1;
        await trx
          .updateTable('password_reset_codes')
          .set({ attempts })
          .where('id', '=', candidate.id)
          .execute();

        if (!hashesEqual(codeHash(body.data.code), candidate.code_hash)) {
          if (attempts >= RESET_CODE_MAX_ATTEMPTS) {
            await trx
              .updateTable('password_reset_codes')
              .set({ used_at: sql<Date>`now()` })
              .where('id', '=', candidate.id)
              .execute();
          }
          return null;
        }

        await storePasswordAndRevokeSessions(trx, candidate.user_id, passwordHash);
        await trx
          .updateTable('password_reset_codes')
          .set({ used_at: sql<Date>`now()` })
          .where('id', '=', candidate.id)
          .execute();
        return candidate.user_id;
      });

      if (resetUserId === null) {
        invalidResetCode(res);
        return;
      }
      deps.logger.info({ userId: resetUserId }, 'password_reset_success');
      res.status(204).end();
    }),
  );

  return router;
}
