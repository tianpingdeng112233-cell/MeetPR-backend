import { createHash, createPublicKey, type JsonWebKey } from 'node:crypto';

import jwt, { type JwtPayload } from 'jsonwebtoken';

const JWKS_CACHE_MS = 10 * 60 * 1000;
const JWKS_REFRESH_COOLDOWN_MS = 30 * 1000;
const UNKNOWN_KID_CACHE_MS = 30 * 1000;
const UNKNOWN_KID_CACHE_MAX = 100;
// Real Apple/Google key ids are short hex or base64url strings. An unauthenticated
// caller can otherwise push a header-sized `kid` into the negative cache, so cap the
// length on the way in and key the cache by digest rather than by the raw value.
const MAX_KID_LENGTH = 256;

function unknownKidKey(kid: string): string {
  return createHash('sha256').update(kid, 'utf8').digest('hex');
}

interface JwkSet {
  keys: JsonWebKey[];
}

interface CachedJwkSet {
  expiresAt: number;
  value: JwkSet;
}

interface ProviderJwksState {
  cache?: CachedJwkSet;
  inFlight?: Promise<JwkSet>;
  lastRefreshAt?: number;
  unknownKids: Map<string, number>;
}

export interface VerifiedOidcIdentity {
  subject: string;
  email: string | null;
}

export class OidcKeysUnavailableError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseJwkSet(value: unknown): JwkSet {
  if (!isRecord(value) || !Array.isArray(value.keys)) {
    throw new OidcKeysUnavailableError('OIDC JWKS response is malformed');
  }
  const keys = value.keys.filter((key): key is JsonWebKey => isRecord(key));
  if (keys.length === 0) {
    throw new OidcKeysUnavailableError('OIDC JWKS contains no keys');
  }
  return { keys };
}

function payloadIdentity(payload: string | JwtPayload, nowSeconds: number): VerifiedOidcIdentity {
  if (typeof payload === 'string' || typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new jwt.JsonWebTokenError('OIDC token is missing sub');
  }
  if (
    typeof payload.exp !== 'number' ||
    !Number.isInteger(payload.exp) ||
    payload.exp <= nowSeconds
  ) {
    throw new jwt.JsonWebTokenError('OIDC token has an invalid exp');
  }
  if (payload.iat !== undefined && (!Number.isInteger(payload.iat) || payload.iat > nowSeconds)) {
    throw new jwt.JsonWebTokenError('OIDC token has an invalid iat');
  }
  return {
    subject: payload.sub,
    email: typeof payload.email === 'string' && payload.email.length > 0 ? payload.email : null,
  };
}

export function createOidcVerifier(fetchImpl: typeof fetch = fetch) {
  const states = new Map<string, ProviderJwksState>();

  function stateFor(url: string): ProviderJwksState {
    const existing = states.get(url);
    if (existing) return existing;
    const created: ProviderJwksState = { unknownKids: new Map() };
    states.set(url, created);
    return created;
  }

  async function refreshJwkSet(url: string, state: ProviderJwksState): Promise<JwkSet> {
    if (state.inFlight) return state.inFlight;

    state.lastRefreshAt = Date.now();
    const request = (async () => {
      try {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(5_000) });
        if (!response.ok) {
          throw new OidcKeysUnavailableError(
            `OIDC signing keys returned ${String(response.status)}`,
          );
        }
        const value = parseJwkSet(await response.json());
        state.cache = { value, expiresAt: Date.now() + JWKS_CACHE_MS };
        state.unknownKids.clear();
        return value;
      } catch (error: unknown) {
        if (error instanceof OidcKeysUnavailableError) throw error;
        throw new OidcKeysUnavailableError('Unable to load OIDC signing keys', { cause: error });
      } finally {
        delete state.inFlight;
      }
    })();
    state.inFlight = request;
    return request;
  }

  async function currentJwkSet(url: string, state: ProviderJwksState): Promise<JwkSet> {
    const now = Date.now();
    if (state.cache && state.cache.expiresAt > now) return state.cache.value;
    if (state.inFlight) return state.inFlight;
    if (state.lastRefreshAt !== undefined && now - state.lastRefreshAt < JWKS_REFRESH_COOLDOWN_MS) {
      throw new OidcKeysUnavailableError('OIDC signing key refresh is cooling down');
    }
    return refreshJwkSet(url, state);
  }

  function matchingJwk(jwks: JwkSet, kid: string): JsonWebKey | undefined {
    return jwks.keys.find(
      (candidate) =>
        candidate.kid === kid &&
        candidate.kty === 'RSA' &&
        (candidate.use === undefined || candidate.use === 'sig') &&
        (candidate.alg === undefined || candidate.alg === 'RS256'),
    );
  }

  async function signingKey(url: string, kid: string): Promise<ReturnType<typeof createPublicKey>> {
    const state = stateFor(url);
    const now = Date.now();
    const negativeKey = unknownKidKey(kid);
    const negativeExpiry = state.unknownKids.get(negativeKey);
    if (negativeExpiry !== undefined) {
      if (negativeExpiry > now) {
        throw new jwt.JsonWebTokenError('No matching OIDC signing key');
      }
      state.unknownKids.delete(negativeKey);
    }

    let jwks = await currentJwkSet(url, state);
    let jwk = matchingJwk(jwks, kid);
    const canRefresh =
      state.lastRefreshAt === undefined ||
      Date.now() - state.lastRefreshAt >= JWKS_REFRESH_COOLDOWN_MS;
    if (!jwk && state.inFlight) {
      jwks = await state.inFlight;
      jwk = matchingJwk(jwks, kid);
    } else if (!jwk && canRefresh) {
      jwks = await refreshJwkSet(url, state);
      jwk = matchingJwk(jwks, kid);
    }
    if (!jwk) {
      for (const [unknownKid, expiresAt] of state.unknownKids) {
        if (expiresAt <= Date.now()) state.unknownKids.delete(unknownKid);
      }
      while (state.unknownKids.size >= UNKNOWN_KID_CACHE_MAX) {
        const oldest = state.unknownKids.keys().next().value;
        if (oldest === undefined) break;
        state.unknownKids.delete(oldest);
      }
      state.unknownKids.set(unknownKidKey(kid), Date.now() + UNKNOWN_KID_CACHE_MS);
      throw new jwt.JsonWebTokenError('No matching OIDC signing key');
    }

    try {
      return createPublicKey({ key: jwk, format: 'jwk' });
    } catch (error: unknown) {
      throw new OidcKeysUnavailableError('OIDC signing key is malformed', { cause: error });
    }
  }

  return async function verifyOidcToken(input: {
    token: string;
    jwksUrl: string;
    issuer: string | [string, ...string[]];
    audience: string;
    nonce?: string;
  }): Promise<VerifiedOidcIdentity> {
    const decoded = jwt.decode(input.token, { complete: true });
    if (
      decoded === null ||
      typeof decoded.header.kid !== 'string' ||
      decoded.header.kid.length === 0 ||
      decoded.header.kid.length > MAX_KID_LENGTH ||
      decoded.header.alg !== 'RS256'
    ) {
      throw new jwt.JsonWebTokenError('OIDC token header is invalid');
    }

    const key = await signingKey(input.jwksUrl, decoded.header.kid);
    const payload = jwt.verify(input.token, key, {
      algorithms: ['RS256'],
      issuer: input.issuer,
      audience: input.audience,
      ...(input.nonce === undefined ? {} : { nonce: input.nonce }),
    });
    return payloadIdentity(payload, Math.floor(Date.now() / 1000));
  };
}
