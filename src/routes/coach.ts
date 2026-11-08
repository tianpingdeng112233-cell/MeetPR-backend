import { Router } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { Database } from '../db/types';
import { updateCoachRpe } from '../handlers/coach-rpe';
import {
  listCoachStudents,
  renameCoachStudent,
  setCoachStudentServiceTerm,
  unbindCoachStudent,
} from '../handlers/coach-students';
import type { Logger } from '../logger';
import { tryEnqueuePushOutbox } from '../services/push-outbox';
import { requireRole } from '../middleware/auth';
import { notImplemented } from '../utils/notImplemented';
import { route, validationEnvelope } from './http';
import { ServiceUntilSchema } from './service-term-schema';

interface CoachRouterDeps {
  db: Kysely<Database>;
  logger: Logger;
  pushEnabled?: boolean;
}

const StudentIdParamsSchema = z.object({ id: z.string().uuid() });
const SetLogIdParamsSchema = z.object({ id: z.string().uuid() });
const ServiceTermBodySchema = z.object({ service_until: ServiceUntilSchema }).strict();
const RenameStudentBodySchema = z
  .object({
    alias: z.string().trim().max(100).nullable().optional(),
    display_name: z.string().trim().max(100).optional(),
  })
  .strict()
  .refine((body) => body.alias !== undefined || body.display_name !== undefined, {
    message: 'alias or display_name is required',
  });
const CoachRpeBodySchema = z
  .object({
    coach_rpe: z.number().min(0).max(10).multipleOf(0.5).nullable(),
  })
  .strict();

export function coachRouter(deps: CoachRouterDeps): Router {
  const router = Router();

  router.get('/dashboard', (_req, res) => {
    notImplemented(res, 'GET /coach/dashboard');
  });

  router.get(
    '/students',
    requireRole('coach'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const students = await listCoachStudents(
        deps.db,
        req.user.id,
        req.query.include_ended === '1',
      );
      res.status(200).json({ students });
    }),
  );

  router.put(
    '/students/:id/service-term',
    requireRole('coach'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }
      const params = StudentIdParamsSchema.safeParse(req.params);
      const body = ServiceTermBodySchema.safeParse(req.body);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }
      const result = await setCoachStudentServiceTerm(
        deps.db,
        req.user.id,
        params.data.id,
        body.data.service_until,
      );
      if (!result) {
        res.status(404).json({ error: 'COACH_STUDENT_NOT_FOUND' });
        return;
      }
      res.status(200).json(result);
    }),
  );

  router.post(
    '/students/:id/unbind',
    requireRole('coach'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }
      const params = StudentIdParamsSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }
      const ended = await unbindCoachStudent(deps.db, req.user.id, params.data.id);
      if (!ended) {
        res.status(404).json({ error: 'COACH_STUDENT_NOT_FOUND' });
        return;
      }
      if (deps.pushEnabled) {
        const coachId = req.user.id;
        await tryEnqueuePushOutbox(deps.db, deps.logger, 'bind_ended', async () => {
          const coach = await deps.db
            .selectFrom('coach_profiles')
            .select('display_name')
            .where('user_id', '=', coachId)
            .executeTakeFirst();
          return {
            aggregateId: ended.id,
            recipientId: ended.student_id,
            payload: {
              coach_name: coach?.display_name ?? null,
              student_id: ended.student_id,
              request_id: ended.id,
            },
          };
        });
      }
      res.status(200).json({});
    }),
  );

  router.patch(
    '/set-logs/:id/coach-rpe',
    requireRole('coach'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const params = SetLogIdParamsSchema.safeParse(req.params);
      const body = CoachRpeBodySchema.safeParse(req.body);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      const result = await updateCoachRpe(
        deps.db,
        req.user.id,
        params.data.id,
        body.data.coach_rpe,
      );
      if (!result) {
        res.status(403).json({ error: 'AUTHORIZATION_FORBIDDEN' });
        return;
      }

      deps.logger.info(
        {
          set_log_id: result.set_log_id,
          coach_id: req.user.id,
          before: result.before,
          after: result.after,
        },
        'coach_rpe_updated',
      );
      res.status(200).json({
        set_log_id: result.set_log_id,
        coach_rpe: result.after,
      });
    }),
  );

  router.patch(
    '/students/:id',
    requireRole('coach'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const params = StudentIdParamsSchema.safeParse(req.params);
      const body = RenameStudentBodySchema.safeParse(req.body);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      const student = await renameCoachStudent(
        deps.db,
        req.user.id,
        params.data.id,
        body.data.alias !== undefined ? body.data.alias : (body.data.display_name ?? null),
      );
      if (!student) {
        res.status(404).json({ error: 'COACH_STUDENT_NOT_FOUND' });
        return;
      }

      res.status(200).json(student);
    }),
  );

  return router;
}
