import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

import { jwtAudience, jwtIssuer, type Config } from '../config';
import { USER_ROLES } from '../db/types';

const AccessTokenPayloadSchema = z
  .object({
    sub: z.string().min(1),
    role: z.enum(USER_ROLES),
    typ: z.literal('access'),
    aud: z.string().min(1),
    iss: z.string().min(1),
    iat: z.number().int(),
    exp: z.number().int(),
  })
  .strict();

export type AccessTokenPayload = z.infer<typeof AccessTokenPayloadSchema>;

export function createRequireAuth(
  config: Pick<Config, 'JWT_ACCESS_SECRET' | 'JWT_AUDIENCE' | 'JWT_ISSUER'>,
): RequestHandler {
  return (req, res, next) => {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
      return;
    }

    const token = header.slice('Bearer '.length).trim();
    if (token.length === 0) {
      res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
      return;
    }

    let payload: unknown;
    try {
      payload = jwt.verify(token, config.JWT_ACCESS_SECRET, {
        algorithms: ['HS256'],
        audience: jwtAudience(config),
        issuer: jwtIssuer(config),
      });
    } catch {
      res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
      return;
    }

    const parsed = AccessTokenPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
      return;
    }

    req.user = { id: parsed.data.sub, role: parsed.data.role };
    next();
  };
}

export function requireRole(...allowed: AccessTokenPayload['role'][]): RequestHandler {
  return (req, res, next) => {
    if (!req.user) {
      res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
      return;
    }

    if (!allowed.includes(req.user.role)) {
      res.status(403).json({ error: 'AUTHORIZATION_FORBIDDEN' });
      return;
    }

    next();
  };
}
