import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

import { allowLegacyTokens, jwtAudience, jwtIssuer, type Config } from '../config';
import { USER_ROLES, type UserRole } from '../db/types';

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

type AuthConfig = Pick<
  Config,
  'JWT_ACCESS_SECRET' | 'JWT_AUDIENCE' | 'JWT_ISSUER' | 'AUTH_ALLOW_LEGACY_TOKENS'
>;

interface AuthenticatedUser {
  id: string;
  role: UserRole;
}

/**
 * The single source of truth for access-token validation, shared by the strict
 * (createRequireAuth) and optional (createOptionalAuth) guards. Returns the
 * authenticated principal, or null for any failure — missing/blank header,
 * bad signature, wrong algorithm/aud/iss, expiry, or a payload that fails the
 * schema. Never throws and never mutates the request.
 *
 * Security posture: HS256 only, aud/iss enforced. When legacy grace is on, a
 * token that fails the strict verify is retried WITHOUT the aud/iss requirement
 * so sessions minted before those claims existed keep working; signature and
 * expiry are still enforced, so a tampered or expired (TokenExpiredError) token
 * is rejected on both paths. A wrong `typ` never satisfies either schema, so a
 * refresh token can't cross into an access-protected surface.
 */
function verifyBearerToken(
  header: string | undefined,
  config: AuthConfig,
): AuthenticatedUser | null {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return null;
  }

  const token = header.slice('Bearer '.length).trim();
  if (token.length === 0) {
    return null;
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
    if (!allowLegacyTokens(config) || error instanceof jwt.TokenExpiredError) {
      return null;
    }
    try {
      payload = jwt.verify(token, config.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
      legacy = true;
    } catch {
      return null;
    }
  }

  const parsed = (legacy ? LegacyAccessTokenPayloadSchema : AccessTokenPayloadSchema).safeParse(
    payload,
  );
  if (!parsed.success) {
    return null;
  }

  return { id: parsed.data.sub, role: parsed.data.role };
}

export function createRequireAuth(config: AuthConfig): RequestHandler {
  return (req, res, next) => {
    const user = verifyBearerToken(req.headers.authorization, config);
    if (!user) {
      res.status(401).json({ error: 'AUTH_INVALID_TOKEN' });
      return;
    }

    req.user = user;
    next();
  };
}

/**
 * Like createRequireAuth, but NEVER 401s. A valid Bearer token sets req.user;
 * anything else (missing/blank/invalid/legacy-rejected/forged token) leaves
 * req.user unset and calls next(). This is what keeps the pre-login onboarding
 * funnel alive: an anon `onboarding_step` event must not be rejected for lacking
 * a token (SPEC §2). It shares verifyBearerToken with the strict guard, so a
 * legacy token that requireAuth would accept is credited here too (req.user
 * set), and one it would reject degrades to anonymous rather than 401.
 *
 * exactOptionalPropertyTypes gate: never assign `req.user = undefined` (type
 * error). Unset it with `delete` so the type stays `{id, role} | absent`.
 */
export function createOptionalAuth(config: AuthConfig): RequestHandler {
  return (req, _res, next) => {
    delete req.user;

    const user = verifyBearerToken(req.headers.authorization, config);
    if (user) {
      req.user = user;
    }
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
