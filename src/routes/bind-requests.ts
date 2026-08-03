import { Router, type Response, type Router as ExpressRouter } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { Database } from '../db/types';
import type { Logger } from '../logger';
import {
  cancelBindRequest,
  createBindRequest,
  fetchMyBindRequest,
} from '../handlers/bind-requests';
import {
  acceptBindRequest,
  fetchCoachBindRequestQueue,
  rejectBindRequest,
  type RespondBindRequestResult,
} from '../handlers/coach-bind-requests';
import { requireRole } from '../middleware/auth';
import { tryEnqueuePushOutbox } from '../services/push-outbox';
import { route, validationEnvelope } from './http';

interface BindRequestsRouterDeps {
  db: Kysely<Database>;
  logger: Logger;
  pushEnabled?: boolean;
}

const IdParamSchema = z.object({
  id: z.string().uuid(),
});

const CreateBindRequestBodySchema = z
  .object({
    code: z.string().trim().min(1).max(20),
    display_name: z.string().trim().min(1).max(100),
  })
  .strict();

const AcceptBindRequestBodySchema = z
  .object({
    skip_evaluation: z.boolean(),
    skip_reason: z.string().trim().min(1).max(500).nullable().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (!body.skip_evaluation && body.skip_reason != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['skip_reason'],
        message: 'skip_reason is only allowed when skip_evaluation is true',
      });
    }
  });

const RejectBindRequestBodySchema = z.object({}).strict();

export function studentBindRequestsRouter(deps: BindRequestsRouterDeps): ExpressRouter {
  const router = Router();

  router.post(
    '/',
    requireRole('coached_student'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const body = CreateBindRequestBodySchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      const result = await createBindRequest(deps.db, req.user.id, body.data);
      switch (result.type) {
        case 'created': {
          if (deps.pushEnabled) {
            await tryEnqueuePushOutbox(deps.db, deps.logger, 'bind_request', () => ({
              aggregateId: result.bindRequest.id,
              recipientId: result.bindRequest.coach_id,
              payload: {
                student_name: body.data.display_name,
                request_id: result.bindRequest.id,
              },
            }));
          }
          res.status(201).json(result.bindRequest);
          return;
        }
        case 'already-pending':
          res.status(409).json({ error: 'BIND_REQUEST_ALREADY_PENDING' });
          return;
        case 'already-bound':
          res.status(409).json({ error: 'BIND_ALREADY_BOUND' });
          return;
        case 'invalid-code':
          res.status(400).json({ error: 'INVITE_CODE_INVALID' });
          return;
      }
    }),
  );

  router.get(
    '/mine',
    requireRole('coached_student'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const bindRequest = await fetchMyBindRequest(deps.db, req.user.id);
      res.status(200).json({ bind_request: bindRequest });
    }),
  );

  router.delete(
    '/:id',
    requireRole('coached_student'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const params = IdParamSchema.safeParse(req.params);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }

      const result = await cancelBindRequest(deps.db, req.user.id, params.data.id);
      if (result === 'not-found') {
        res.status(404).json({ error: 'BIND_REQUEST_NOT_FOUND' });
        return;
      }
      if (result === 'not-pending') {
        res.status(409).json({ error: 'BIND_REQUEST_NOT_PENDING' });
        return;
      }

      res.status(204).send();
    }),
  );

  return router;
}

function respondWithGateError(res: Response, result: RespondBindRequestResult): void {
  switch (result.type) {
    case 'not-found':
      res.status(404).json({ error: 'BIND_REQUEST_NOT_FOUND' });
      return;
    case 'expired':
      res.status(409).json({ error: 'BIND_REQUEST_EXPIRED' });
      return;
    case 'not-pending':
      res.status(409).json({ error: 'BIND_REQUEST_NOT_PENDING' });
      return;
    case 'already-bound':
      res.status(409).json({ error: 'BIND_ALREADY_BOUND' });
      return;
    default:
      return;
  }
}

export function coachBindRequestsRouter(deps: BindRequestsRouterDeps): ExpressRouter {
  const router = Router();

  router.get(
    '/bind-requests',
    requireRole('coach'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const bindRequests = await fetchCoachBindRequestQueue(deps.db, req.user.id);
      res.status(200).json({ bind_requests: bindRequests });
    }),
  );

  router.post(
    '/bind-requests/:id/accept',
    requireRole('coach'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const params = IdParamSchema.safeParse(req.params);
      const body = AcceptBindRequestBodySchema.safeParse(req.body);
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      const result = await acceptBindRequest(deps.db, req.user.id, params.data.id, {
        skip_evaluation: body.data.skip_evaluation,
        skip_reason: body.data.skip_reason ?? null,
      });

      if (result.type !== 'accepted') {
        respondWithGateError(res, result);
        return;
      }

      res.status(200).json({
        bind_request: result.bindRequest,
        evaluation_period: result.evaluationPeriod,
      });
    }),
  );

  router.post(
    '/bind-requests/:id/reject',
    requireRole('coach'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const params = IdParamSchema.safeParse(req.params);
      const body = RejectBindRequestBodySchema.safeParse(req.body ?? {});
      if (!params.success) {
        res.status(400).json(validationEnvelope(params.error));
        return;
      }
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      const result = await rejectBindRequest(deps.db, req.user.id, params.data.id);
      if (result.type !== 'rejected') {
        respondWithGateError(res, result);
        return;
      }

      res.status(200).json({ bind_request: result.bindRequest });
    }),
  );

  return router;
}
