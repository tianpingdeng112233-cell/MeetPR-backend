import { generateKeyPairSync, type KeyObject } from 'node:crypto';

import jwt from 'jsonwebtoken';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOidcVerifier, OidcKeysUnavailableError } from '../../src/services/oidc';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rotatedKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = 'oidc-unit-key';
const rotatedKid = 'oidc-rotated-key';
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
const rotatedJwk = {
  ...rotatedKeys.publicKey.export({ format: 'jwk' }),
  kid: rotatedKid,
  alg: 'RS256',
  use: 'sig',
};
const issuer = 'https://issuer.example.test';
const audience = 'client-id';
const jwksUrl = 'https://keys.example.test';

function fetchJwks(jwks = [jwk]) {
  return vi.fn(async () =>
    Promise.resolve(
      new Response(JSON.stringify({ keys: jwks }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  ) as unknown as typeof fetch;
}

function token(
  overrides: {
    audience?: string;
    expiresIn?: number;
    futureIat?: boolean;
    explicitExp?: number;
    explicitIat?: number;
    key?: KeyObject;
    keyid?: string;
    missingExp?: boolean;
    nonce?: string;
  } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      sub: 'provider-user',
      email: 'user@example.com',
      nonce: overrides.nonce ?? 'nonce',
      ...(overrides.futureIat
        ? { iat: now + 60 }
        : overrides.explicitIat === undefined
          ? {}
          : { iat: overrides.explicitIat }),
      ...(overrides.explicitExp === undefined ? {} : { exp: overrides.explicitExp }),
    },
    overrides.key ?? keys.privateKey,
    {
      algorithm: 'RS256',
      keyid: overrides.keyid ?? kid,
      issuer,
      audience: overrides.audience ?? audience,
      ...(overrides.missingExp || overrides.explicitExp !== undefined
        ? {}
        : { expiresIn: overrides.expiresIn ?? 300 }),
    },
  );
}

function verifyInput(signedToken: string, nonce = 'nonce') {
  return {
    token: signedToken,
    jwksUrl,
    issuer,
    audience,
    nonce,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('OIDC JWKS verification', () => {
  it('accepts RS256 with matching issuer, audience, expiry, and nonce', async () => {
    const fetchMock = fetchJwks();
    const verify = createOidcVerifier(fetchMock);

    await expect(verify(verifyInput(token()))).resolves.toEqual({
      subject: 'provider-user',
      email: 'user@example.com',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('accepts aud=b when the allowed audiences are a and b', async () => {
    const verify = createOidcVerifier(fetchJwks());
    await expect(
      verify({ ...verifyInput(token({ audience: 'b' })), audience: ['a', 'b'] }),
    ).resolves.toEqual({ subject: 'provider-user', email: 'user@example.com' });
  });

  it('rejects aud=c when the allowed audiences are a and b', async () => {
    const verify = createOidcVerifier(fetchJwks());
    await expect(
      verify({ ...verifyInput(token({ audience: 'c' })), audience: ['a', 'b'] }),
    ).rejects.toBeInstanceOf(jwt.JsonWebTokenError);
  });

  it('rejects a token when no audiences are allowed', async () => {
    const verify = createOidcVerifier(fetchJwks());
    await expect(verify({ ...verifyInput(token()), audience: [] })).rejects.toBeInstanceOf(
      jwt.JsonWebTokenError,
    );
  });

  it.each([
    ['audience mismatch', { audience: 'wrong-audience' }, 'nonce'],
    ['expired', { expiresIn: -1 }, 'nonce'],
    ['nonce mismatch', {}, 'wrong-nonce'],
    ['missing exp', { missingExp: true }, 'nonce'],
    ['future iat', { futureIat: true }, 'nonce'],
  ] as const)('rejects %s', async (_name, overrides, nonce) => {
    const verify = createOidcVerifier(fetchJwks());
    await expect(verify(verifyInput(token(overrides), nonce))).rejects.toBeInstanceOf(Error);
  });

  it('requires integer exp and iat claims', async () => {
    const verify = createOidcVerifier(fetchJwks());
    const now = Math.floor(Date.now() / 1000);

    await expect(verify(verifyInput(token({ explicitExp: now + 300.5 })))).rejects.toBeInstanceOf(
      jwt.JsonWebTokenError,
    );
    await expect(
      verify(
        verifyInput(
          token({
            explicitExp: now + 300,
            explicitIat: now - 0.5,
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(jwt.JsonWebTokenError);
  });

  it('classifies non-JSON JWKS responses as provider unavailable', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response('<html>upstream error</html>', { status: 200 })),
    );
    const verify = createOidcVerifier(fetchMock);

    await expect(verify(verifyInput(token()))).rejects.toBeInstanceOf(OidcKeysUnavailableError);
  });

  it('classifies unusable matching JWKs as provider unavailable', async () => {
    const malformedJwk = { kid, kty: 'RSA', alg: 'RS256', use: 'sig' };
    const verify = createOidcVerifier(fetchJwks([malformedJwk]));

    await expect(verify(verifyInput(token()))).rejects.toBeInstanceOf(OidcKeysUnavailableError);
  });

  it('negative-caches an unknown kid and does not double-fetch on a cold cache', async () => {
    const fetchMock = fetchJwks();
    const verify = createOidcVerifier(fetchMock);
    const unknown = token({ keyid: 'unknown-kid' });

    await expect(verify(verifyInput(unknown))).rejects.toBeInstanceOf(jwt.JsonWebTokenError);
    await expect(verify(verifyInput(unknown))).rejects.toBeInstanceOf(jwt.JsonWebTokenError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('applies a provider refresh cooldown across different random kids', async () => {
    const fetchMock = fetchJwks();
    const verify = createOidcVerifier(fetchMock);
    await verify(verifyInput(token()));

    await expect(verify(verifyInput(token({ keyid: 'random-kid-1' })))).rejects.toBeInstanceOf(
      jwt.JsonWebTokenError,
    );
    await expect(verify(verifyInput(token({ keyid: 'random-kid-2' })))).rejects.toBeInstanceOf(
      jwt.JsonWebTokenError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('single-flights concurrent refreshes for one provider', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T12:00:00.000Z'));
    const fetchMock = fetchJwks();
    const verify = createOidcVerifier(fetchMock);
    await verify(verifyInput(token()));
    vi.advanceTimersByTime(31_000);

    const results = await Promise.allSettled([
      verify(verifyInput(token({ keyid: 'concurrent-unknown-1' }))),
      verify(verifyInput(token({ keyid: 'concurrent-unknown-2' }))),
      verify(verifyInput(token({ keyid: 'concurrent-unknown-3' }))),
    ]);

    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares one cold-cache request across concurrent valid verifications', async () => {
    const fetchMock = fetchJwks();
    const verify = createOidcVerifier(fetchMock);

    const results = await Promise.all([
      verify(verifyInput(token())),
      verify(verifyInput(token())),
      verify(verifyInput(token())),
    ]);

    expect(results).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('picks up a rotated key after the refresh cooldown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T12:00:00.000Z'));
    let currentKeys = [jwk];
    const fetchMock = vi.fn(async () =>
      Promise.resolve(new Response(JSON.stringify({ keys: currentKeys }), { status: 200 })),
    ) as unknown as typeof fetch;
    const verify = createOidcVerifier(fetchMock);
    await verify(verifyInput(token()));

    currentKeys = [jwk, rotatedJwk];
    vi.advanceTimersByTime(31_000);
    await expect(
      verify(
        verifyInput(
          token({
            key: rotatedKeys.privateKey,
            keyid: rotatedKid,
          }),
        ),
      ),
    ).resolves.toMatchObject({ subject: 'provider-user' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
