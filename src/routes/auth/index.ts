import bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import {
  Router,
  type Request,
  type RequestHandler,
  type Response,
  type Router as ExpressRouter,
} from 'express';
import jwt, { type SignOptions } from 'jsonwebtoken';
import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import type { ZodError } from 'zod';

import {
  allowLegacyTokens,
  isRegistrationEnabled,
  jwtAudience,
  jwtIssuer,
  registrationAllowlist,
  type Config,
} from '../../config';
import type { Database, UsersTable, UserRole } from '../../db/types';
import type { Logger } from '../../logger';
import {
  LegacyRefreshTokenPayloadSchema,
  LoginBodySchema,
  RefreshBodySchema,
  RefreshTokenPayloadSchema,
  RegisterBodySchema,
} from './schemas';

const BCRYPT_COST = 10;

type AuthConfig = Pick<
  Config,
  | 'JWT_ACCESS_SECRET'
  | 'JWT_REFRESH_SECRET'
  | 'JWT_ACCESS_TTL'
  | 'JWT_REFRESH_TTL'
  | 'JWT_AUDIENCE'
  | 'JWT_ISSUER'
  | 'AUTH_ALLOW_LEGACY_TOKENS'
  | 'NODE_ENV'
  | 'REGISTRATION_ENABLED'
  | 'REGISTRATION_ALLOWLIST'
>;

interface AuthRouterDeps {
  config: AuthConfig;
  db: Kysely<Database>;
  logger: Logger;
}

interface ClientUser {
  id: string;
  phone: string;
  role: UserRole;
  createdAt: string;
}

type ClientUserRow = Pick<Selectable<UsersTable>, 'id' | 'phone' | 'role' | 'created_at'>;

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

function toClientUser(row: ClientUserRow): ClientUser {
  return {
    id: row.id,
    phone: row.phone,
    role: row.role,
    createdAt: row.created_at.toISOString(),
  };
}

function signTokenPair(config: AuthConfig, userId: string, role: UserRole, jti: string): TokenPair {
  type JwtTtl = NonNullable<SignOptions['expiresIn']>;

  const accessOptions: SignOptions = {
    algorithm: 'HS256',
    expiresIn: config.JWT_ACCESS_TTL as JwtTtl,
    audience: jwtAudience(config),
    issuer: jwtIssuer(config),
  };
  const refreshOptions: SignOptions = {
    algorithm: 'HS256',
    expiresIn: config.JWT_REFRESH_TTL as JwtTtl,
    audience: jwtAudience(config),
    issuer: jwtIssuer(config),
  };

  return {
    accessToken: jwt.sign(
      { sub: userId, role, typ: 'access' },
      config.JWT_ACCESS_SECRET,
      accessOptions,
    ),
    refreshToken: jwt.sign(
      { sub: userId, role, jti, typ: 'refresh' },
      config.JWT_REFRESH_SECRET,
      refreshOptions,
    ),
  };
}

function registrationRejection(
  config: AuthConfig,
  input: { phone: string; role: UserRole },
): 'AUTH_REGISTRATION_DISABLED' | 'AUTH_REGISTRATION_NOT_ALLOWED' | null {
  if (!isRegistrationEnabled(config)) return 'AUTH_REGISTRATION_DISABLED';

  // Coach identities are provisioned by an operator. Even when a small
  // production cohort is allowlisted, a client cannot create a coach account.
  if (config.NODE_ENV === 'production' && input.role === 'coach') {
    return 'AUTH_REGISTRATION_NOT_ALLOWED';
  }
  if (config.NODE_ENV === 'production' && !registrationAllowlist(config).has(input.phone)) {
    return 'AUTH_REGISTRATION_NOT_ALLOWED';
  }
  return null;
}

function validationEnvelope(error: ZodError) {
  return {
    error: 'VALIDATION_ERROR',
    issues: error.issues.map((issue) => ({
      path: issue.path,
      message: issue.message,
    })),
  };
}

function isUsersPhoneUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { code?: unknown; constraint?: unknown };
  return (
    record.code === '23505' &&
    (record.constraint === undefined || record.constraint === 'users_phone_key')
  );
}

function route(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}

export function authRouter(deps: AuthRouterDeps): ExpressRouter {
  const router = Router();

  router.post(
    '/register',
    route(async (req, res) => {
      const body = RegisterBodySchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      const registrationError = registrationRejection(deps.config, body.data);
      if (registrationError !== null) {
        res.status(403).json({ error: registrationError });
        return;
      }

      const passwordHash = await bcrypt.hash(body.data.password, BCRYPT_COST);

      let user: ClientUserRow;
      try {
        user = await deps.db
          .insertInto('users')
          .values({
            phone: body.data.phone,
            password_hash: passwordHash,
            role: body.data.role,
          })
          .returning(['id', 'phone', 'role', 'created_at'])
          .executeTakeFirstOrThrow();
      } catch (error: unknown) {
        if (isUsersPhoneUniqueViolation(error)) {
          res.status(409).json({ error: 'AUTH_PHONE_TAKEN' });
          return;
        }
        throw error;
      }

      const jti = randomUUID();
      await deps.db
        .updateTable('users')
        .set({ refresh_token_jti: jti, updated_at: sql<Date>`now()` })
        .where('id', '=', user.id)
        .execute();

      const tokens = signTokenPair(deps.config, user.id, user.role, jti);
      deps.logger.info({ userId: user.id, role: user.role }, 'auth_register_success');

      res.status(201).json({ user: toClientUser(user), ...tokens });
    }),
  );

  router.post(
    '/login',
    route(async (req, res) => {
      const body = LoginBodySchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      const user = await deps.db
        .selectFrom('users')
        .select(['id', 'phone', 'password_hash', 'role', 'created_at'])
        .where('phone', '=', body.data.phone)
        .executeTakeFirst();

      if (!user) {
        res.status(401).json({ error: 'AUTH_INVALID_CREDENTIALS' });
        return;
      }

      const passwordMatches = await bcrypt.compare(body.data.password, user.password_hash);
      if (!passwordMatches) {
        res.status(401).json({ error: 'AUTH_INVALID_CREDENTIALS' });
        return;
      }

      const jti = randomUUID();
      await deps.db
        .updateTable('users')
        .set({ refresh_token_jti: jti, updated_at: sql<Date>`now()` })
        .where('id', '=', user.id)
        .execute();

      const tokens = signTokenPair(deps.config, user.id, user.role, jti);
      deps.logger.info({ userId: user.id, role: user.role }, 'auth_login_success');

      res.status(200).json({
        user: toClientUser(user),
        ...tokens,
      });
    }),
  );

  router.post(
    '/refresh',
    route(async (req, res) => {
      const body = RefreshBodySchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }

      let verifiedPayload: unknown;
      let legacyRefresh = false;
      try {
        verifiedPayload = jwt.verify(body.data.refreshToken, deps.config.JWT_REFRESH_SECRET, {
          algorithms: ['HS256'],
          audience: jwtAudience(deps.config),
          issuer: jwtIssuer(deps.config),
        });
      } catch (error: unknown) {
        if (error instanceof jwt.TokenExpiredError) {
          res.status(401).json({ error: 'AUTH_REFRESH_EXPIRED' });
          return;
        }
        // A refresh token minted before the aud/iss claims existed fails the
        // strict verify. When legacy grace is on, retry without the aud/iss
        // requirement; expiry was already enforced above, and rotation re-issues
        // a full-claim token so the holder migrates forward on this refresh.
        if (!allowLegacyTokens(deps.config)) {
          res.status(401).json({ error: 'AUTH_INVALID_REFRESH' });
          return;
        }
        try {
          verifiedPayload = jwt.verify(body.data.refreshToken, deps.config.JWT_REFRESH_SECRET, {
            algorithms: ['HS256'],
          });
          legacyRefresh = true;
        } catch {
          res.status(401).json({ error: 'AUTH_INVALID_REFRESH' });
          return;
        }
      }

      const payload = (
        legacyRefresh ? LegacyRefreshTokenPayloadSchema : RefreshTokenPayloadSchema
      ).safeParse(verifiedPayload);
      if (!payload.success) {
        res.status(401).json({ error: 'AUTH_INVALID_REFRESH' });
        return;
      }

      const newJti = randomUUID();
      const rotatedUser = await deps.db
        .updateTable('users')
        .set({ refresh_token_jti: newJti, updated_at: sql<Date>`now()` })
        .where('id', '=', payload.data.sub)
        .where('refresh_token_jti', '=', payload.data.jti)
        .returning(['id', 'role'])
        .executeTakeFirst();

      if (!rotatedUser) {
        const existingUser = await deps.db
          .selectFrom('users')
          .select(['id'])
          .where('id', '=', payload.data.sub)
          .executeTakeFirst();

        if (existingUser) {
          await deps.db
            .updateTable('users')
            .set({ refresh_token_jti: null, updated_at: sql<Date>`now()` })
            .where('id', '=', payload.data.sub)
            .execute();
          deps.logger.warn({ userId: payload.data.sub }, 'auth_refresh_reuse_detected');
        }

        res.status(401).json({ error: 'AUTH_INVALID_REFRESH' });
        return;
      }

      const tokens = signTokenPair(deps.config, rotatedUser.id, rotatedUser.role, newJti);
      deps.logger.info({ userId: rotatedUser.id, role: rotatedUser.role }, 'auth_refresh_success');

      res.status(200).json(tokens);
    }),
  );

  return router;
}
