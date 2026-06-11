import { Router, type Router as ExpressRouter } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { Database } from '../db/types';
import { INVITE_CODE_TYPES } from '../db/types';
import { createInviteCode, listInviteCodes, revokeInviteCode } from '../handlers/invite-codes';
import { requireRole } from '../middleware/auth';
import { route, validationEnvelope } from './http';

interface InviteCodesRouterDeps {
  db: Kysely<Database>;
}

const IdParamSchema = z.object({
  id: z.string().uuid(),
});

const CreateInviteCodeBodySchema = z
  .object({
    type: z.enum(INVITE_CODE_TYPES),
    label: z.string().trim().min(1).max(100).nullable().optional(),
    expires_in_days: z.number().int().min(1).max(365).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.type === 'time_limited' && body.expires_in_days === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expires_in_days'],
        message: 'expires_in_days is required for time_limited codes',
      });
    }
    if (body.type !== 'time_limited' && body.expires_in_days !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expires_in_days'],
        message: 'expires_in_days is only allowed for time_limited codes',
      });
    }
  });

export function coachInviteCodesRouter(deps: InviteCodesRouterDeps): ExpressRouter {
  const router = Router();

  router.post(
    '/invite-codes',
    requireRole('coach'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const body = CreateInviteCodeBodySchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      const inviteCode = await createInviteCode(deps.db, req.user.id, {
        type: body.data.type,
        label: body.data.label ?? null,
        expires_in_days: body.data.expires_in_days ?? null,
      });
      res.status(201).json(inviteCode);
    }),
  );

  router.get(
    '/invite-codes',
    requireRole('coach'),
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }

      const inviteCodes = await listInviteCodes(deps.db, req.user.id);
      res.status(200).json({ invite_codes: inviteCodes });
    }),
  );

  router.delete(
    '/invite-codes/:id',
    requireRole('coach'),
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

      const revoked = await revokeInviteCode(deps.db, req.user.id, params.data.id);
      if (!revoked) {
        res.status(404).json({ error: 'INVITE_CODE_NOT_FOUND' });
        return;
      }

      res.status(204).send();
    }),
  );

  return router;
}
