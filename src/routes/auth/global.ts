import bcrypt from 'bcrypt';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';

import { Router, type Router as ExpressRouter } from 'express';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import { z } from 'zod';

import { selfSignupRoles, type Config } from '../../config';
import { REGISTERABLE_ROLES, type Database, type UserRole } from '../../db/types';
import type { Logger } from '../../logger';
import { createSignupEmailRateLimit, createSignupIpRateLimit } from '../../middleware/rateLimit';
import { sendAlreadyRegisteredEmail, sendSignupCodeEmail } from '../../services/mail';
import { appleCredentials, exchangeAppleAuthorizationCode } from '../../services/apple';
import { createOidcVerifier, OidcKeysUnavailableError } from '../../services/oidc';
import { requestedTimeZone } from '../../utils/timezone';
import { route, validationEnvelope } from '../http';
import { BCRYPT_COST } from './constants';
import { codeHash, hashesEqual } from './email-code';
import { emailRecoveryRouter } from './email-recovery';
import { PasswordSchema } from './schemas';

const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const SignupRoleSchema = z.enum(REGISTERABLE_ROLES);
const NonceSchema = z.string().min(1).max(512);
const AppleBodySchema = z
  .object({
    identityToken: z.string().min(1),
    nonce: NonceSchema,
    role: SignupRoleSchema,
    authorizationCode: z.string().min(1).optional(),
    timezone: z.string().optional(),
  })
  .strict();
const GoogleBodySchema = z
  .object({
    idToken: z.string().min(1),
    nonce: NonceSchema.optional(),
    role: SignupRoleSchema,
    timezone: z.string().optional(),
  })
  .strict();
const EmailSignupCodeBodySchema = z.object({ email: z.string().trim().email().max(320) }).strict();
const EmailRegisterBodySchema = z
  .object({
    email: z.string().trim().email().max(320),
    password: PasswordSchema,
    role: SignupRoleSchema,
    timezone: z.string().optional(),
  })
  .strict();
const VerifiedEmailRegisterBodySchema = EmailRegisterBodySchema.extend({
  code: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});
const LegacyEmailRegisterBodySchema = EmailRegisterBodySchema.extend({
  code: z.unknown().optional(),
});
const EmailLoginBodySchema = z
  .object({
    email: z.string().trim().email().max(320),
    password: PasswordSchema,
  })
  .strict();

type GlobalAuthConfig = Pick<
  Config,
  | 'EMAIL_SIGNUP_VERIFICATION'
  | 'MAIL_LOCALE'
  | 'SELF_SIGNUP_ROLES'
  | 'APPLE_CLIENT_ID'
  | 'GOOGLE_CLIENT_IDS'
  | 'RESEND_API_KEY'
  | 'EMAIL_FROM'
  | 'SIWA_KEY_ID'
  | 'SIWA_TEAM_ID'
  | 'SIWA_PRIVATE_KEY'
>;

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

interface GlobalIdentityRouterDeps {
  config: GlobalAuthConfig;
  db: Kysely<Database>;
  logger: Logger;
  createSession: (
    trx: Transaction<Database>,
    userId: string,
    refreshTokenJti: string,
  ) => Promise<void>;
  issueTokens: (userId: string, role: UserRole, jti: string) => TokenPair;
  fetch?: typeof fetch;
}

interface IdentityClaims {
  subject: string;
  email: string | null;
}

interface GlobalUserRow {
  id: string;
  phone: string | null;
  email: string | null;
  role: UserRole;
  created_at: Date;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function lockSignupEmail(trx: Transaction<Database>, email: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${email}))`.execute(trx);
}

function nonceHash(nonce: string): string {
  return createHash('sha256').update(nonce, 'utf8').digest('hex');
}

async function consumeChallenge(deps: GlobalIdentityRouterDeps, nonce: string): Promise<boolean> {
  const consumed = await deps.db
    .deleteFrom('auth_challenges')
    .where('nonce_hash', '=', nonceHash(nonce))
    .where('issued_at', '>', sql<Date>`now() - interval '10 minutes'`)
    .where('issued_at', '<=', sql<Date>`now()`)
    .returning('nonce_hash')
    .executeTakeFirst();
  return consumed !== undefined;
}

function signupError(
  config: Pick<GlobalAuthConfig, 'SELF_SIGNUP_ROLES'>,
  role: UserRole,
): 'AUTH_REGISTRATION_DISABLED' | 'AUTH_REGISTRATION_NOT_ALLOWED' | null {
  if (role === 'coach' || role === 'admin') return 'AUTH_REGISTRATION_NOT_ALLOWED';
  if (!selfSignupRoles(config).has(role)) return 'AUTH_REGISTRATION_DISABLED';
  return null;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
  );
}

function clientUser(row: GlobalUserRow, providerEmail: string | null = null) {
  return {
    id: row.id,
    phone: row.phone,
    email: row.email ?? providerEmail,
    role: row.role,
    createdAt: row.created_at.toISOString(),
  };
}

async function findIdentity(
  trx: Transaction<Database>,
  provider: 'apple' | 'google',
  providerUid: string,
): Promise<GlobalUserRow | undefined> {
  return trx
    .selectFrom('user_identities as identity')
    .innerJoin('users as user', 'user.id', 'identity.user_id')
    .select(['user.id', 'user.phone', 'user.email', 'user.role', 'user.created_at'])
    .where('identity.provider', '=', provider)
    .where('identity.provider_uid', '=', providerUid)
    .forUpdate()
    .executeTakeFirst();
}

async function authenticateIdentity(
  deps: GlobalIdentityRouterDeps,
  provider: 'apple' | 'google',
  claims: IdentityClaims,
  role: UserRole,
  timezone: string,
): Promise<{ user: GlobalUserRow; jti: string; created: boolean } | string> {
  const existingLogin = await deps.db.transaction().execute(async (trx) => {
    const existing = await findIdentity(trx, provider, claims.subject);
    if (!existing) return null;
    const jti = randomUUID();
    await deps.createSession(trx, existing.id, jti);
    return { user: existing, jti, created: false };
  });
  if (existingLogin) return existingLogin;

  const rejection = signupError(deps.config, role);
  if (rejection !== null) return rejection;

  // Keep the established NOT NULL password invariant without creating a
  // usable local credential: this per-account random value is never returned
  // or persisted outside its bcrypt hash. Hash before opening the write
  // transaction so CPU work never extends a database lock window.
  const passwordHash = await bcrypt.hash(randomUUID(), BCRYPT_COST);

  try {
    return await deps.db.transaction().execute(async (trx) => {
      // Close the gap between the first lookup and the bcrypt work. If another
      // request created the identity, this request becomes an ordinary login.
      const existing = await findIdentity(trx, provider, claims.subject);
      if (existing) {
        const jti = randomUUID();
        await deps.createSession(trx, existing.id, jti);
        return { user: existing, jti, created: false };
      }

      const user = await trx
        .insertInto('users')
        .values({ phone: null, email: null, password_hash: passwordHash, role, timezone })
        .returning(['id', 'phone', 'email', 'role', 'created_at'])
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('user_identities')
        .values({
          user_id: user.id,
          provider,
          provider_uid: claims.subject,
          email_at_provider: claims.email,
        })
        .execute();
      const jti = randomUUID();
      await deps.createSession(trx, user.id, jti);
      return { user, jti, created: true };
    });
  } catch (error: unknown) {
    if (!isUniqueViolation(error)) throw error;

    // Two first-login requests can both observe an absent identity. The unique
    // constraint chooses the winner; the loser retries as a normal login.
    return deps.db.transaction().execute(async (trx) => {
      const existing = await findIdentity(trx, provider, claims.subject);
      if (!existing) throw error;
      const jti = randomUUID();
      await deps.createSession(trx, existing.id, jti);
      return { user: existing, jti, created: false };
    });
  }
}

export function globalIdentityRouter(deps: GlobalIdentityRouterDeps): ExpressRouter {
  const router = Router();
  const verifyOidcToken = createOidcVerifier(deps.fetch);

  router.post(
    '/challenge',
    route(async (_req, res) => {
      const nonce = randomBytes(32).toString('base64url');
      const challenge = await deps.db.transaction().execute(async (trx) => {
        await trx
          .deleteFrom('auth_challenges')
          .where('issued_at', '<=', sql<Date>`now() - interval '10 minutes'`)
          .execute();
        return trx
          .insertInto('auth_challenges')
          .values({ nonce_hash: nonceHash(nonce) })
          .returning('issued_at')
          .executeTakeFirstOrThrow();
      });

      res.status(200).json({
        nonce,
        expiresAt: new Date(challenge.issued_at.getTime() + CHALLENGE_TTL_MS).toISOString(),
      });
    }),
  );

  router.post(
    '/apple',
    route(async (req, res) => {
      const timezone = requestedTimeZone(req.body);
      if (timezone === null) {
        res.status(400).json({ error: 'INVALID_TIMEZONE' });
        return;
      }
      const body = AppleBodySchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }
      if (deps.config.APPLE_CLIENT_ID === undefined) {
        res.status(503).json({ error: 'AUTH_PROVIDER_NOT_CONFIGURED', provider: 'apple' });
        return;
      }
      if (!(await consumeChallenge(deps, body.data.nonce))) {
        res.status(401).json({ error: 'AUTH_INVALID_IDENTITY_TOKEN' });
        return;
      }

      let claims: IdentityClaims;
      try {
        claims = await verifyOidcToken({
          token: body.data.identityToken,
          jwksUrl: APPLE_JWKS_URL,
          issuer: 'https://appleid.apple.com',
          audience: deps.config.APPLE_CLIENT_ID,
          nonce: nonceHash(body.data.nonce),
        });
      } catch (error: unknown) {
        if (error instanceof OidcKeysUnavailableError) {
          res.status(503).json({ error: 'AUTH_PROVIDER_UNAVAILABLE', provider: 'apple' });
          return;
        }
        res.status(401).json({ error: 'AUTH_INVALID_IDENTITY_TOKEN' });
        return;
      }

      const login = await authenticateIdentity(deps, 'apple', claims, body.data.role, timezone);
      if (typeof login === 'string') {
        res.status(403).json({ error: login });
        return;
      }
      if (body.data.authorizationCode !== undefined) {
        const credentials = appleCredentials(deps.config);
        if (credentials === null) {
          deps.logger.warn({ userId: login.user.id }, 'apple_token_exchange_not_configured');
        } else {
          try {
            const refreshToken = await exchangeAppleAuthorizationCode(
              credentials,
              body.data.authorizationCode,
              deps.fetch,
            );
            await deps.db
              .updateTable('user_identities')
              .set({ apple_refresh_token: refreshToken })
              .where('user_id', '=', login.user.id)
              .where('provider', '=', 'apple')
              .execute();
          } catch (error: unknown) {
            deps.logger.error({ err: error, userId: login.user.id }, 'apple_token_exchange_failed');
          }
        }
      }
      const tokens = deps.issueTokens(login.user.id, login.user.role, login.jti);
      deps.logger.info(
        { userId: login.user.id, role: login.user.role, created: login.created },
        'auth_apple_success',
      );
      res.status(200).json({
        user: clientUser(login.user, claims.email),
        ...tokens,
      });
    }),
  );

  router.post(
    '/google',
    route(async (req, res) => {
      const timezone = requestedTimeZone(req.body);
      if (timezone === null) {
        res.status(400).json({ error: 'INVALID_TIMEZONE' });
        return;
      }
      const body = GoogleBodySchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }
      if (deps.config.GOOGLE_CLIENT_IDS === undefined) {
        res.status(503).json({ error: 'AUTH_PROVIDER_NOT_CONFIGURED', provider: 'google' });
        return;
      }
      if (body.data.nonce !== undefined && !(await consumeChallenge(deps, body.data.nonce))) {
        res.status(401).json({ error: 'AUTH_INVALID_IDENTITY_TOKEN' });
        return;
      }

      let claims: IdentityClaims;
      try {
        claims = await verifyOidcToken({
          token: body.data.idToken,
          jwksUrl: GOOGLE_JWKS_URL,
          issuer: ['accounts.google.com', 'https://accounts.google.com'],
          audience: deps.config.GOOGLE_CLIENT_IDS,
          ...(body.data.nonce === undefined ? {} : { nonce: nonceHash(body.data.nonce) }),
        });
      } catch (error: unknown) {
        if (error instanceof OidcKeysUnavailableError) {
          res.status(503).json({ error: 'AUTH_PROVIDER_UNAVAILABLE', provider: 'google' });
          return;
        }
        res.status(401).json({ error: 'AUTH_INVALID_IDENTITY_TOKEN' });
        return;
      }

      const login = await authenticateIdentity(deps, 'google', claims, body.data.role, timezone);
      if (typeof login === 'string') {
        res.status(403).json({ error: login });
        return;
      }
      const tokens = deps.issueTokens(login.user.id, login.user.role, login.jti);
      deps.logger.info(
        { userId: login.user.id, role: login.user.role, created: login.created },
        'auth_google_success',
      );
      res.status(200).json({
        user: clientUser(login.user, claims.email),
        ...tokens,
      });
    }),
  );

  router.post(
    '/email/register/code',
    (req, res, next) => {
      if (deps.config.EMAIL_SIGNUP_VERIFICATION !== 'required') {
        next('router');
        return;
      }
      if (selfSignupRoles(deps.config).size === 0) {
        res.status(403).json({ error: 'AUTH_REGISTRATION_DISABLED' });
        return;
      }
      next();
    },
    createSignupIpRateLimit(),
    createSignupEmailRateLimit(),
    route(async (req, res) => {
      const body = EmailSignupCodeBodySchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }
      const email = normalizeEmail(body.data.email);
      const code = await deps.db.transaction().execute(async (trx) => {
        // No user row exists yet: a transaction-scoped email lock serializes
        // issuance with other issuances and verification across app instances.
        await lockSignupEmail(trx, email);
        const identity = await trx
          .selectFrom('user_identities')
          .select('user_id')
          .where('provider', '=', 'email')
          .where('provider_uid', '=', email)
          .executeTakeFirst();
        if (identity) return null;
        await trx
          .deleteFrom('email_signup_codes')
          .where('email', '=', email)
          .where('expires_at', '<=', sql<Date>`now()`)
          .execute();
        await trx
          .updateTable('email_signup_codes')
          .set({ used_at: sql<Date>`now()` })
          .where('email', '=', email)
          .where('used_at', 'is', null)
          .execute();
        const value = randomInt(0, 1_000_000).toString().padStart(6, '0');
        await trx
          .insertInto('email_signup_codes')
          .values({
            email,
            code_hash: codeHash(value),
            expires_at: new Date(Date.now() + 10 * 60 * 1000),
          })
          .execute();
        return value;
      });
      if (deps.config.RESEND_API_KEY === undefined || deps.config.EMAIL_FROM === undefined) {
        deps.logger.warn('signup_email_not_configured');
      } else {
        const input = {
          apiKey: deps.config.RESEND_API_KEY,
          from: deps.config.EMAIL_FROM,
          to: email,
          locale: deps.config.MAIL_LOCALE ?? 'en',
        };
        // As with forgot, delivery latency never delays the public response.
        const delivery =
          code === null
            ? sendAlreadyRegisteredEmail(input, deps.fetch)
            : sendSignupCodeEmail({ ...input, code }, deps.fetch);
        void delivery.catch((error: unknown) => {
          deps.logger.error({ err: error }, 'signup_email_failed');
        });
      }
      res.status(204).end();
    }),
  );

  router.post(
    '/email/register',
    route(async (req, res) => {
      const timezone = requestedTimeZone(req.body);
      if (timezone === null) {
        res.status(400).json({ error: 'INVALID_TIMEZONE' });
        return;
      }
      const verificationRequired = deps.config.EMAIL_SIGNUP_VERIFICATION === 'required';
      const body = (
        verificationRequired ? VerifiedEmailRegisterBodySchema : LegacyEmailRegisterBodySchema
      ).safeParse(req.body);
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }
      const rejection = signupError(deps.config, body.data.role);
      if (rejection !== null) {
        res.status(403).json({ error: rejection });
        return;
      }

      if (verificationRequired && body.data.code === undefined) {
        res.status(401).json({ error: 'AUTH_INVALID_SIGNUP_CODE' });
        return;
      }

      const email = normalizeEmail(body.data.email);
      const passwordHash = await bcrypt.hash(body.data.password, BCRYPT_COST);
      try {
        const registration = await deps.db.transaction().execute(async (trx) => {
          if (verificationRequired) {
            if (typeof body.data.code !== 'string') return null;
            await lockSignupEmail(trx, email);
            const candidate = await trx
              .selectFrom('email_signup_codes')
              .select(['id', 'code_hash', 'attempts'])
              .where('email', '=', email)
              .where('used_at', 'is', null)
              .where('expires_at', '>', sql<Date>`now()`)
              .where('attempts', '<', 5)
              .orderBy('created_at', 'desc')
              .orderBy('id', 'desc')
              .forUpdate()
              .executeTakeFirst();
            if (!candidate) return null;
            const attempts = candidate.attempts + 1;
            await trx
              .updateTable('email_signup_codes')
              .set({ attempts })
              .where('id', '=', candidate.id)
              .execute();
            if (!hashesEqual(codeHash(body.data.code), candidate.code_hash)) {
              if (attempts >= 5) {
                await trx
                  .updateTable('email_signup_codes')
                  .set({ used_at: sql<Date>`now()` })
                  .where('id', '=', candidate.id)
                  .execute();
              }
              return null;
            }
            await trx
              .updateTable('email_signup_codes')
              .set({ used_at: sql<Date>`now()` })
              .where('id', '=', candidate.id)
              .execute();
          }
          const user = await trx
            .insertInto('users')
            .values({
              phone: null,
              email,
              email_verified_at: verificationRequired ? sql<Date>`now()` : null,
              password_hash: passwordHash,
              role: body.data.role,
              timezone,
            })
            .returning(['id', 'phone', 'email', 'role', 'created_at'])
            .executeTakeFirstOrThrow();
          await trx
            .insertInto('user_identities')
            .values({
              user_id: user.id,
              provider: 'email',
              provider_uid: email,
              email_at_provider: email,
            })
            .execute();
          const jti = randomUUID();
          await deps.createSession(trx, user.id, jti);
          return { user, jti };
        });

        if (registration === null) {
          res.status(401).json({ error: 'AUTH_INVALID_SIGNUP_CODE' });
          return;
        }
        const tokens = deps.issueTokens(
          registration.user.id,
          registration.user.role,
          registration.jti,
        );
        deps.logger.info(
          { userId: registration.user.id, role: registration.user.role },
          'auth_email_register_success',
        );
        res.status(201).json({ user: clientUser(registration.user), ...tokens });
      } catch (error: unknown) {
        if (isUniqueViolation(error)) {
          res.status(409).json({ error: 'AUTH_EMAIL_TAKEN' });
          return;
        }
        throw error;
      }
    }),
  );

  router.post(
    '/email/login',
    route(async (req, res) => {
      const body = EmailLoginBodySchema.safeParse(req.body);
      if (!body.success) {
        res.status(400).json(validationEnvelope(body.error));
        return;
      }
      const email = normalizeEmail(body.data.email);
      // bcrypt.compare burns ~100ms of CPU, so it must not run while holding
      // the user row lock (same reasoning as hashing before the signup
      // transaction above). Read and compare lock-free first; the transaction
      // below re-checks the hash under the lock before minting a session.
      const candidate = await deps.db
        .selectFrom('user_identities as identity')
        .innerJoin('users as user', 'user.id', 'identity.user_id')
        .select(['user.id', 'user.password_hash'])
        .where('identity.provider', '=', 'email')
        .where('identity.provider_uid', '=', email)
        .executeTakeFirst();
      if (!candidate || !(await bcrypt.compare(body.data.password, candidate.password_hash))) {
        res.status(401).json({ error: 'AUTH_INVALID_CREDENTIALS' });
        return;
      }

      const login = await deps.db.transaction().execute(async (trx) => {
        // The row lock serializes createSession so concurrent logins cannot
        // overshoot the session cap. Requiring the hash to be unchanged keeps
        // the lock-free compare honest: a concurrent password change (which
        // revokes all sessions) invalidates this login instead of issuing a
        // session for the old password.
        const user = await trx
          .selectFrom('users')
          .select(['id', 'phone', 'email', 'password_hash', 'role', 'created_at'])
          .where('id', '=', candidate.id)
          .forUpdate()
          .executeTakeFirst();
        if (user?.password_hash !== candidate.password_hash) return null;

        const jti = randomUUID();
        await deps.createSession(trx, user.id, jti);
        return { user, jti };
      });
      if (!login) {
        res.status(401).json({ error: 'AUTH_INVALID_CREDENTIALS' });
        return;
      }

      const tokens = deps.issueTokens(login.user.id, login.user.role, login.jti);
      deps.logger.info(
        { userId: login.user.id, role: login.user.role },
        'auth_email_login_success',
      );
      res.status(200).json({ user: clientUser(login.user), ...tokens });
    }),
  );

  router.use(
    '/email',
    emailRecoveryRouter({
      config: deps.config,
      db: deps.db,
      logger: deps.logger,
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    }),
  );

  return router;
}
