import { Router, type Router as ExpressRouter } from 'express';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { Database } from '../db/types';
import { route, validationEnvelope } from './http';

interface DevicesRouterDeps {
  db: Kysely<Database>;
}

const DeviceTokenBodySchema = z
  .object({
    token: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[0-9a-f]+$/i, 'token must be hexadecimal')
      .transform((token) => token.toLowerCase()),
    platform: z.literal('ios'),
  })
  .strict();

export function devicesRouter(deps: DevicesRouterDeps): ExpressRouter {
  const router = Router();

  router.post(
    '/token',
    route(async (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }
      const userId = req.user.id;

      const body = DeviceTokenBodySchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      const now = new Date();
      const deviceToken = await deps.db
        .insertInto('device_tokens')
        .values({
          user_id: userId,
          token: body.data.token,
          platform: body.data.platform,
          last_seen_at: now,
          updated_at: now,
        })
        .onConflict((conflict) =>
          conflict.column('token').doUpdateSet({
            user_id: userId,
            last_seen_at: now,
            updated_at: now,
          }),
        )
        .returning('id')
        .executeTakeFirstOrThrow();

      res.status(201).json({ id: deviceToken.id });
    }),
  );

  return router;
}
