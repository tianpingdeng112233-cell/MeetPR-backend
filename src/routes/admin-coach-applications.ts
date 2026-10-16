import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import {
  COACH_SETUP_PENDING_HASH,
  ApplicationError,
  approveApplication,
  deliverCoachWelcome,
  deliverCoachRejection,
  issueCoachSetup,
} from '../services/coachApplications';
import type { CoachApplicationDeps } from './coach-applications';
import { route, validationEnvelope } from './http';
const Params = z.object({ id: z.string().uuid() });
export function adminCoachApplicationsRouter(deps: CoachApplicationDeps) {
  const router = Router();
  router.get(
    '/',
    route(async (_req, res) => {
      const applications = await deps.db
        .selectFrom('coach_applications')
        .selectAll()
        .orderBy('created_at', 'desc')
        .execute();
      res.json({ applications });
    }),
  );
  for (const action of ['approve', 'reject', 'resend'] as const) {
    router.post(
      `/:id/${action}`,
      route(async (req, res) => {
        const params = Params.safeParse(req.params);
        if (!params.success) {
          res.status(400).json(validationEnvelope(params.error));
          return;
        }
        const id = params.data.id;
        const adminId = req.user?.id;
        if (!adminId) {
          res.status(401).json({ error: 'AUTHENTICATION_REQUIRED' });
          return;
        }
        try {
          if (action === 'approve') {
            res.json(await approveApplication(deps, id, adminId));
            return;
          }
          if (action === 'reject') {
            const rejected = await deps.db
              .updateTable('coach_applications')
              .set({ status: 'rejected', reviewed_by: adminId, reviewed_at: sql<Date>`now()` })
              .where('id', '=', id)
              .where('status', '=', 'pending')
              .returning(['id', 'status', 'email'])
              .executeTakeFirst();
            if (!rejected) throw new ApplicationError('COACH_APPLICATION_REVIEWED');
            res.json({
              id: rejected.id,
              status: rejected.status,
              result_email_sent: await deliverCoachRejection(deps, rejected.email, rejected.id),
            });
            return;
          }
          const rejected = await deps.db
            .selectFrom('coach_applications')
            .select(['id', 'email'])
            .where('id', '=', id)
            .where('status', '=', 'rejected')
            .executeTakeFirst();
          if (rejected) {
            res.json({ result_email_sent: await deliverCoachRejection(deps, rejected.email, id) });
            return;
          }
          const issued = await deps.db.transaction().execute(async (trx) => {
            const application = await trx
              .selectFrom('coach_applications')
              .selectAll()
              .where('id', '=', id)
              .forUpdate()
              .executeTakeFirst();
            if (!application?.user_id || application.status !== 'approved')
              throw new ApplicationError('COACH_APPLICATION_NOT_APPROVED');
            const user = await trx
              .selectFrom('users')
              .select(['id', 'password_hash'])
              .where('id', '=', application.user_id)
              .forUpdate()
              .executeTakeFirstOrThrow();
            if (user.password_hash !== COACH_SETUP_PENDING_HASH)
              throw new ApplicationError('COACH_SETUP_COMPLETE');
            return {
              email: application.email,
              userId: user.id,
              token: await issueCoachSetup(trx, user.id),
            };
          });
          res.json({
            welcome_email_sent: await deliverCoachWelcome(
              deps,
              issued.email,
              issued.token,
              issued.userId,
            ),
          });
        } catch (error) {
          if (error instanceof ApplicationError) {
            res.status(error.status).json({ error: error.code });
            return;
          }
          // A competing signup can win after the precheck; the entire approval
          // transaction rolls back and the operator receives a stable conflict.
          if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === '23505'
          ) {
            res.status(409).json({ error: 'COACH_APPLICATION_EMAIL_EXISTS' });
            return;
          }
          throw error;
        }
      }),
    );
  }
  return router;
}
