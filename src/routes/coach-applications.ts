import { Router, type Router as ExpressRouter } from 'express';
import rateLimit from 'express-rate-limit';
import type { Kysely } from 'kysely';
import {
  COACH_SETUP_PENDING_HASH,
  coachMailInput,
  deliverCoachWelcome,
  deliverCoachRejection,
  issueCoachSetup,
} from '../services/coachApplications';
import { createForgotEmailRateLimit, createForgotIpRateLimit } from '../middleware/rateLimit';
import { z } from 'zod';
import type { Config } from '../config';
import type { Database } from '../db/types';
import type { Logger } from '../logger';
import { sendCoachApplicationReceipt } from '../services/mail';
import { route, validationEnvelope } from './http';

export interface CoachApplicationDeps {
  config: Config;
  db: Kysely<Database>;
  logger: Logger;
}
const EmailSchema = z
  .string()
  .trim()
  .email()
  .max(320)
  .transform((value) => value.toLowerCase());
const ApplicationSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    email: EmailSchema,
    contact: z.string().trim().max(200).optional(),
    student_count: z.number().int().min(0).max(100000),
    device: z.enum(['iphone', 'android', 'both']),
  })
  .strict();
function applicationLimit(byEmail = false) {
  return rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: byEmail ? 5 : 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'rate_limited' },
    ...(byEmail
      ? {
          keyGenerator: (req) => {
            const email = (req.body as { email?: unknown } | undefined)?.email;
            return typeof email === 'string' ? email.trim().toLowerCase() : 'invalid-email';
          },
          validate: { ip: false },
        }
      : {}),
  });
}
export function coachApplicationsRouter(deps: CoachApplicationDeps): ExpressRouter {
  const router = Router();
  router.post(
    '/',
    applicationLimit(),
    applicationLimit(true),
    route(async (req, res) => {
      const body = ApplicationSchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }
      let application;
      try {
        application = await deps.db
          .insertInto('coach_applications')
          .values({
            ...body.data,
            contact: body.data.contact === '' ? null : (body.data.contact ?? null),
          })
          .returning(['id', 'status'])
          .executeTakeFirstOrThrow();
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === '23505'
        ) {
          res.status(409).json({ error: 'COACH_APPLICATION_EXISTS' });
          return;
        }
        throw error;
      }
      let receiptEmailSent = false;
      try {
        await sendCoachApplicationReceipt(coachMailInput(deps, body.data.email));
        receiptEmailSent = true;
      } catch {
        deps.logger.error({ applicationId: application.id }, 'coach_application_receipt_failed');
      }
      res.status(201).json({ ...application, receipt_email_sent: receiptEmailSent });
    }),
  );
  router.post(
    '/resend',
    createForgotIpRateLimit(),
    createForgotEmailRateLimit(),
    route(async (req, res) => {
      const body = z.object({ email: EmailSchema }).strict().safeParse(req.body);
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }
      const rejected = await deps.db
        .selectFrom('coach_applications')
        .select('id')
        .where('email', '=', body.data.email)
        .where('status', '=', 'rejected')
        .executeTakeFirst();
      if (rejected) {
        void deliverCoachRejection(deps, body.data.email, rejected.id);
        res.status(204).end();
        return;
      }
      const pending = await deps.db
        .selectFrom('coach_applications')
        .select('id')
        .where('email', '=', body.data.email)
        .where('status', '=', 'pending')
        .executeTakeFirst();
      if (pending) {
        void sendCoachApplicationReceipt(coachMailInput(deps, body.data.email)).catch(() => {
          deps.logger.error({ applicationId: pending.id }, 'coach_application_receipt_failed');
        });
        res.status(204).end();
        return;
      }
      const issued = await deps.db.transaction().execute(async (trx) => {
        const user = await trx
          .selectFrom('users')
          .select(['id', 'password_hash'])
          .where('email', '=', body.data.email)
          .where('role', '=', 'coach')
          .forUpdate()
          .executeTakeFirst();
        if (user?.password_hash !== COACH_SETUP_PENDING_HASH) return null;
        const application = await trx
          .selectFrom('coach_applications')
          .select('id')
          .where('user_id', '=', user.id)
          .where('status', '=', 'approved')
          .executeTakeFirst();
        if (!application) return null;
        return { userId: user.id, token: await issueCoachSetup(trx, user.id) };
      });
      // Match /auth/email/forgot's anti-enumeration response and asynchronous mail.
      if (issued) void deliverCoachWelcome(deps, body.data.email, issued.token, issued.userId);
      res.status(204).end();
    }),
  );
  return router;
}
