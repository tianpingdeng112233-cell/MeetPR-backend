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
import type { Kysely, Selectable, Transaction } from 'kysely';
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
const MAX_ACTIVE_SESSIONS = 5;
const PREVIOUS_JTI_GRACE_SECONDS = 60;

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

type RefreshResult =
  | {
      status: 'success';
      userId: string;
      role: UserRole;
      jti: string;
    }
  | {
      status: 'invalid';
      reuseDetected: boolean;
      sessionId: string | null;
    };

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

async function revokeExcessSessions(trx: Transaction<Database>, userId: string): Promise<void> {
  const activeSessions = await trx
    .selectFrom('sessions')
    .select(['id'])
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .orderBy('last_used_at', 'asc')
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
  const excessCount = activeSessions.length - MAX_ACTIVE_SESSIONS;
  if (excessCount <= 0) return;

  await trx
    .updateTable('sessions')
    .set({ revoked_at: sql<Date>`now()` })
    .where(
      'id',
      'in',
      activeSessions.slice(0, excessCount).map((session) => session.id),
    )
    .execute();
}

async function createSession(
  trx: Transaction<Database>,
  userId: string,
  refreshTokenJti: string,
  previousJti: string | null = null,
): Promise<void> {
  await trx
    .insertInto('sessions')
    .values(
      previousJti === null
        ? { user_id: userId, refresh_token_jti: refreshTokenJti }
        : {
            user_id: userId,
            refresh_token_jti: refreshTokenJti,
            prev_jti: previousJti,
            prev_jti_valid_until: sql<Date>`now() + interval '${sql.raw(
              String(PREVIOUS_JTI_GRACE_SECONDS),
            )} seconds'`,
          },
    )
    .execute();
  await revokeExcessSessions(trx, userId);
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

      let registration: { user: ClientUserRow; jti: string };
      try {
        registration = await deps.db.transaction().execute(async (trx) => {
          const user = await trx
            .insertInto('users')
            .values({
              phone: body.data.phone,
              password_hash: passwordHash,
              role: body.data.role,
            })
            .returning(['id', 'phone', 'role', 'created_at'])
            .executeTakeFirstOrThrow();
          const jti = randomUUID();
          await createSession(trx, user.id, jti);
          return { user, jti };
        });
      } catch (error: unknown) {
        if (isUsersPhoneUniqueViolation(error)) {
          res.status(409).json({ error: 'AUTH_PHONE_TAKEN' });
          return;
        }
        throw error;
      }

      const { user, jti } = registration;
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

      const login = await deps.db.transaction().execute(async (trx) => {
        const lockedUser = await trx
          .selectFrom('users')
          .select(['id', 'phone', 'password_hash', 'role', 'created_at'])
          .where('phone', '=', body.data.phone)
          .forUpdate()
          .executeTakeFirst();
        if (!lockedUser) return null;

        const passwordMatches = await bcrypt.compare(body.data.password, lockedUser.password_hash);
        if (!passwordMatches) return null;

        const jti = randomUUID();
        await createSession(trx, lockedUser.id, jti);
        return { user: lockedUser, jti };
      });
      if (!login) {
        res.status(401).json({ error: 'AUTH_INVALID_CREDENTIALS' });
        return;
      }

      const tokens = signTokenPair(deps.config, login.user.id, login.user.role, login.jti);
      deps.logger.info({ userId: login.user.id, role: login.user.role }, 'auth_login_success');

      res.status(200).json({
        user: toClientUser(login.user),
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

      const result = await deps.db.transaction().execute(async (trx): Promise<RefreshResult> => {
        const legacyUser = legacyRefresh
          ? await trx
              .selectFrom('users')
              .select(['id', 'role', 'refresh_token_jti'])
              .where('id', '=', payload.data.sub)
              .forUpdate()
              .executeTakeFirst()
          : undefined;

        const currentSession = await trx
          .selectFrom('sessions')
          .innerJoin('users', 'users.id', 'sessions.user_id')
          .select([
            'sessions.id as session_id',
            'sessions.refresh_token_jti',
            'users.id as user_id',
            'users.role',
          ])
          .where('sessions.user_id', '=', payload.data.sub)
          .where('sessions.refresh_token_jti', '=', payload.data.jti)
          .where('sessions.revoked_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();

        if (currentSession) {
          const newJti = randomUUID();
          await trx
            .updateTable('sessions')
            .set({
              refresh_token_jti: newJti,
              prev_jti: currentSession.refresh_token_jti,
              prev_jti_valid_until: sql<Date>`now() + interval '${sql.raw(
                String(PREVIOUS_JTI_GRACE_SECONDS),
              )} seconds'`,
              last_used_at: sql<Date>`now()`,
            })
            .where('id', '=', currentSession.session_id)
            .execute();
          return {
            status: 'success',
            userId: currentSession.user_id,
            role: currentSession.role,
            jti: newJti,
          };
        }

        const graceSession = await trx
          .selectFrom('sessions')
          .innerJoin('users', 'users.id', 'sessions.user_id')
          .select([
            'sessions.id as session_id',
            'sessions.refresh_token_jti',
            'users.id as user_id',
            'users.role',
          ])
          .where('sessions.user_id', '=', payload.data.sub)
          .where('sessions.prev_jti', '=', payload.data.jti)
          .where('sessions.prev_jti_valid_until', '>', sql<Date>`now()`)
          .where('sessions.revoked_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();

        if (graceSession) {
          return {
            status: 'success',
            userId: graceSession.user_id,
            role: graceSession.role,
            jti: graceSession.refresh_token_jti,
          };
        }

        const staleSession = await trx
          .selectFrom('sessions')
          .select(['id'])
          .where('user_id', '=', payload.data.sub)
          .where('prev_jti', '=', payload.data.jti)
          .where('revoked_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (staleSession) {
          await trx
            .updateTable('sessions')
            .set({ revoked_at: sql<Date>`now()` })
            .where('id', '=', staleSession.id)
            .execute();
          return { status: 'invalid', reuseDetected: true, sessionId: staleSession.id };
        }

        if (legacyRefresh) {
          const knownSession = await trx
            .selectFrom('sessions')
            .select(['id'])
            .where('user_id', '=', payload.data.sub)
            .where((eb) =>
              eb.or([
                eb('refresh_token_jti', '=', payload.data.jti),
                eb('prev_jti', '=', payload.data.jti),
              ]),
            )
            .executeTakeFirst();
          if (knownSession) {
            return { status: 'invalid', reuseDetected: false, sessionId: knownSession.id };
          }

          if (legacyUser?.refresh_token_jti === payload.data.jti) {
            const newJti = randomUUID();
            await createSession(trx, legacyUser.id, newJti, payload.data.jti);
            return {
              status: 'success',
              userId: legacyUser.id,
              role: legacyUser.role,
              jti: newJti,
            };
          }
        }

        return { status: 'invalid', reuseDetected: false, sessionId: null };
      });

      if (result.status === 'invalid') {
        if (result.reuseDetected) {
          deps.logger.warn(
            { userId: payload.data.sub, sessionId: result.sessionId },
            'auth_refresh_reuse_detected',
          );
        }
        res.status(401).json({ error: 'AUTH_INVALID_REFRESH' });
        return;
      }

      const tokens = signTokenPair(deps.config, result.userId, result.role, result.jti);
      deps.logger.info({ userId: result.userId, role: result.role }, 'auth_refresh_success');

      res.status(200).json(tokens);
    }),
  );

  return router;
}
