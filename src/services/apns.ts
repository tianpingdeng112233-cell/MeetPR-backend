import { connect, type ClientHttp2Session, type IncomingHttpHeaders } from 'node:http2';
import jwt from 'jsonwebtoken';

import type { Config } from '../config';
import { PUSH_POLICY } from '../domain/push-policy';

const PROVIDER_TOKEN_TTL_MS = 50 * 60 * 1000;

type ApnsConfig = Pick<
  Config,
  'APNS_KEY' | 'APNS_KEY_ID' | 'APNS_TEAM_ID' | 'APNS_BUNDLE_ID' | 'APNS_ENV'
>;

export interface ApnsResult {
  ok: boolean;
  status: number;
  reason?: string;
}

export interface ApnsSendOptions {
  /**
   * APNs collapse identifier. The consumer passes the outbox row id: when a
   * partially-failed row is retried, re-sends to already-delivered tokens
   * collapse on the device instead of stacking duplicate notifications.
   */
  collapseId?: string;
}

export interface ApnsClient {
  send(token: string, payload: unknown, options?: ApnsSendOptions): Promise<ApnsResult>;
}

interface ApnsRequest {
  origin: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

interface ApnsClientDependencies {
  now?: () => number;
  request?: (request: ApnsRequest) => Promise<ApnsResult>;
}

function required(config: ApnsConfig, field: keyof ApnsConfig): string {
  const value = config[field];
  if (value === undefined) {
    throw new Error(`${field} is required to create the APNs client`);
  }
  return value;
}

function responseReason(body: string): string | undefined {
  if (body.length === 0) return undefined;
  try {
    const decoded = JSON.parse(body) as unknown;
    if (typeof decoded !== 'object' || decoded === null) return undefined;
    const reason = (decoded as { reason?: unknown }).reason;
    return typeof reason === 'string' ? reason : undefined;
  } catch {
    return undefined;
  }
}

function closeSession(session: ClientHttp2Session): void {
  if (!session.closed && !session.destroyed) session.close();
}

// One TLS/HTTP/2 session per send is a deliberate W0 capacity tradeoff: the
// daily digest fans out to a handful of coaches, so connection reuse (with
// goaway/reconnect handling) is not worth its complexity yet. Revisit before
// any per-event push volume.
function sendHttp2Request(request: ApnsRequest): Promise<ApnsResult> {
  return new Promise((resolve, reject) => {
    const session = connect(request.origin);
    let settled = false;

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      session.destroy();
      reject(err);
    };

    // Bounded end-to-end deadline: a half-open APNs connection must never pin
    // the caller (the consumer holds a row lock and a DB connection while
    // awaiting this promise).
    const deadline = setTimeout(() => {
      fail(new Error(`APNs request timed out after ${String(PUSH_POLICY.apnsRequestTimeoutMs)}ms`));
    }, PUSH_POLICY.apnsRequestTimeoutMs);

    session.once('error', fail);
    const stream = session.request({
      ':method': 'POST',
      ':path': request.path,
      ...request.headers,
    });
    let status = 0;
    let body = '';
    stream.setEncoding('utf8');
    stream.on('response', (headers: IncomingHttpHeaders) => {
      const responseStatus = headers[':status'];
      status = typeof responseStatus === 'number' ? responseStatus : Number(responseStatus ?? 0);
    });
    stream.on('data', (chunk: string) => {
      body += chunk;
    });
    stream.once('error', fail);
    stream.once('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      closeSession(session);
      const reason = responseReason(body);
      resolve({
        ok: status >= 200 && status < 300,
        status,
        ...(reason === undefined ? {} : { reason }),
      });
    });
    stream.end(request.body);
  });
}

export function createApnsClient(
  config: ApnsConfig,
  dependencies: ApnsClientDependencies = {},
): ApnsClient {
  const key = required(config, 'APNS_KEY');
  const keyId = required(config, 'APNS_KEY_ID');
  const teamId = required(config, 'APNS_TEAM_ID');
  const bundleId = required(config, 'APNS_BUNDLE_ID');
  const environment = required(config, 'APNS_ENV');
  const origin =
    environment === 'production'
      ? 'https://api.push.apple.com'
      : 'https://api.sandbox.push.apple.com';
  const now = dependencies.now ?? Date.now;
  const request = dependencies.request ?? sendHttp2Request;
  let cachedProviderToken: { value: string; createdAt: number } | undefined;

  function providerToken(): string {
    const currentTime = now();
    // A backwards clock correction must invalidate the cache: a stale token
    // could otherwise outlive its real TTL and carry a future-relative iat.
    if (
      cachedProviderToken !== undefined &&
      currentTime >= cachedProviderToken.createdAt &&
      currentTime - cachedProviderToken.createdAt < PROVIDER_TOKEN_TTL_MS
    ) {
      return cachedProviderToken.value;
    }

    const issuedAt = Math.floor(currentTime / 1000);
    const value = jwt.sign({ iss: teamId, iat: issuedAt }, key, {
      algorithm: 'ES256',
      keyid: keyId,
    });
    cachedProviderToken = { value, createdAt: currentTime };
    return value;
  }

  return {
    send(token, payload, options = {}) {
      return request({
        origin,
        path: `/3/device/${encodeURIComponent(token)}`,
        headers: {
          authorization: `bearer ${providerToken()}`,
          'apns-topic': bundleId,
          'apns-push-type': 'alert',
          'content-type': 'application/json',
          ...(options.collapseId === undefined ? {} : { 'apns-collapse-id': options.collapseId }),
        },
        body: JSON.stringify(payload),
      });
    },
  };
}
