import jwt from 'jsonwebtoken';

import type { Config } from '../config';

const APPLE_AUDIENCE = 'https://appleid.apple.com';
const APPLE_TOKEN_URL = `${APPLE_AUDIENCE}/auth/token`;
const APPLE_REVOKE_URL = `${APPLE_AUDIENCE}/auth/revoke`;

type AppleServerConfig = Pick<
  Config,
  'APPLE_CLIENT_ID' | 'SIWA_KEY_ID' | 'SIWA_TEAM_ID' | 'SIWA_PRIVATE_KEY'
>;

interface AppleCredentials {
  clientId: string;
  keyId: string;
  teamId: string;
  privateKey: string;
}

export function appleCredentials(config: AppleServerConfig): AppleCredentials | null {
  if (
    config.APPLE_CLIENT_ID === undefined ||
    config.SIWA_KEY_ID === undefined ||
    config.SIWA_TEAM_ID === undefined ||
    config.SIWA_PRIVATE_KEY === undefined
  ) {
    return null;
  }
  return {
    clientId: config.APPLE_CLIENT_ID,
    keyId: config.SIWA_KEY_ID,
    teamId: config.SIWA_TEAM_ID,
    privateKey: config.SIWA_PRIVATE_KEY.replace(/\\n/g, '\n'),
  };
}

function clientSecret(credentials: AppleCredentials): string {
  return jwt.sign({}, credentials.privateKey, {
    algorithm: 'ES256',
    keyid: credentials.keyId,
    issuer: credentials.teamId,
    subject: credentials.clientId,
    audience: APPLE_AUDIENCE,
    expiresIn: '5m',
  });
}

function formBody(credentials: AppleCredentials): URLSearchParams {
  return new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: clientSecret(credentials),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function exchangeAppleAuthorizationCode(
  credentials: AppleCredentials,
  authorizationCode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const body = formBody(credentials);
  body.set('code', authorizationCode);
  body.set('grant_type', 'authorization_code');
  const response = await fetchImpl(APPLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Apple token endpoint returned ${String(response.status)}`);

  const payload: unknown = await response.json();
  if (
    !isRecord(payload) ||
    typeof payload.refresh_token !== 'string' ||
    payload.refresh_token.length === 0
  ) {
    throw new Error('Apple token endpoint omitted refresh_token');
  }
  return payload.refresh_token;
}

export async function revokeAppleRefreshToken(
  credentials: AppleCredentials,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const body = formBody(credentials);
  body.set('token', refreshToken);
  body.set('token_type_hint', 'refresh_token');
  const response = await fetchImpl(APPLE_REVOKE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Apple revoke endpoint returned ${String(response.status)}`);
}
