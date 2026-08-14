import { generateKeyPairSync } from 'node:crypto';

import jwt from 'jsonwebtoken';
import { describe, expect, it, vi } from 'vitest';

import {
  appleCredentials,
  exchangeAppleAuthorizationCode,
  revokeAppleRefreshToken,
} from '../../src/services/apple';

const privateKey = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  .privateKey.export({ format: 'pem', type: 'pkcs8' })
  .toString();

const credentials = appleCredentials({
  APPLE_CLIENT_ID: 'com.meetpr.global',
  SIWA_KEY_ID: 'SIWAKEY',
  SIWA_TEAM_ID: 'TEAMID',
  SIWA_PRIVATE_KEY: privateKey.replace(/\n/g, '\\n'),
});

if (credentials === null) throw new Error('test credentials must be complete');

describe('Apple server token service', () => {
  it('exchanges an authorization code using an ES256 client secret', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ refresh_token: 'apple-refresh-token' }), { status: 200 }),
      ),
    );

    await expect(
      exchangeAppleAuthorizationCode(credentials, 'one-time-code', fetchMock),
    ).resolves.toBe('apple-refresh-token');

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://appleid.apple.com/auth/token');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const body = init?.body as URLSearchParams;
    expect(body.get('code')).toBe('one-time-code');
    expect(body.get('grant_type')).toBe('authorization_code');
    const decoded = jwt.decode(String(body.get('client_secret')), { complete: true });
    expect(decoded?.header).toMatchObject({ alg: 'ES256', kid: 'SIWAKEY' });
    expect(decoded?.payload).toMatchObject({
      iss: 'TEAMID',
      sub: 'com.meetpr.global',
      aud: 'https://appleid.apple.com',
    });
  });

  it('posts refresh-token revocation and rejects endpoint failures', async () => {
    const success = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 200 })));
    await revokeAppleRefreshToken(credentials, 'refresh-to-revoke', success);
    const [url, init] = success.mock.calls[0] ?? [];
    expect(url).toBe('https://appleid.apple.com/auth/revoke');
    const body = init?.body as URLSearchParams;
    expect(body.get('token')).toBe('refresh-to-revoke');
    expect(body.get('token_type_hint')).toBe('refresh_token');

    const failure = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 500 })));
    await expect(revokeAppleRefreshToken(credentials, 'refresh', failure)).rejects.toThrow(
      'Apple revoke endpoint returned 500',
    );
  });

  it('treats partial SIWA configuration as disabled', () => {
    expect(
      appleCredentials({
        APPLE_CLIENT_ID: 'com.meetpr.global',
        SIWA_KEY_ID: 'SIWAKEY',
        SIWA_TEAM_ID: undefined,
        SIWA_PRIVATE_KEY: privateKey,
      }),
    ).toBeNull();
  });
});
