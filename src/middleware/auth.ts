import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

import { allowLegacyTokens, jwtAudience, jwtIssuer, type Config } from '../config';
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

// Tokens issued before the typ/aud/iss claims existed only carry sub/role.
// A wrong typ is still rejected, so a refresh token can never satisfy this path.
const LegacyAccessTokenPayloadSchema = z
  .object({
    sub: z.string().min(1),
    role: z.enum(USER_ROLES),
    typ: z.literal('access').optional(),
  })
  .passthrough();

export type AccessTokenPayload = z.infer<typeof AccessTokenPayloadSchema>;

export function createRequireAuth(
  config: Pick<
    Config,
    'JWT_ACCESS_SECRET' | 'JWT_AUDIENCE' | 'JWT_ISSUER' | 'AUTH_ALLOW_LEGACY_TOKENS'
  >,
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
    let legacy = false;
    try {
      payload = jwt.verify(token, config.JWT_ACCESS_SECRET, {
        algorithms: ['HS256'],
        audience: jwtAudience(config),
        issuer: jwtIssuer(config),
      });
    } catch (error: unknown) {
      // A token issued before aud/iss claims existed fails the strict verify.
      // When legacy grace is on, retry without the aud/iss requirement; the
      // signature and expiry are still enforced, so a tampered or expired token
      // (TokenExpiredError) is rejected here regardless.
      if (!allowLegacyTokens(config) || error instanceof jwt.TokenExpiredError) {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }
      try {
        payload = jwt.verify(token, config.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
        legacy = true;
      } catch {
        res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
        return;
      }
    }

    const parsed = (legacy ? LegacyAccessTokenPayloadSchema : AccessTokenPayloadSchema).safeParse(
      payload,
    );
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
