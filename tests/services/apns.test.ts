import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { describe, expect, it, vi } from 'vitest';

import { createApnsClient } from '../../src/services/apns';
import { PUSH_POLICY } from '../../src/domain/push-policy';

function privateKey(): string {
  return generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
}

const baseConfig = {
  APNS_KEY: privateKey(),
  APNS_KEY_ID: 'KEY123',
  APNS_TEAM_ID: 'TEAM123',
  APNS_BUNDLE_ID: 'com.example.meetpr',
  APNS_ENV: 'sandbox' as const,
};

describe('createApnsClient', () => {
  it('reuses its provider JWT until the 50-minute refresh boundary', async () => {
    let currentTime = Date.parse('2026-07-17T00:00:00.000Z');
    const authorizations: string[] = [];
    const request = vi.fn((input: { origin: string; headers: Record<string, string> }) => {
      authorizations.push(input.headers.authorization ?? '');
      expect(input.origin).toBe('https://api.sandbox.push.apple.com');
      return Promise.resolve({ ok: true, status: 200 });
    });
    const client = createApnsClient(baseConfig, { now: () => currentTime, request });

    await client.send('aaaa', { aps: { alert: 'one' } });
    currentTime += 49 * 60 * 1000;
    await client.send('bbbb', { aps: { alert: 'two' } });
    currentTime += 60 * 1000;
    await client.send('cccc', { aps: { alert: 'three' } });

    expect(authorizations[1]).toBe(authorizations[0]);
    expect(authorizations[2]).not.toBe(authorizations[0]);
    const decoded = jwt.decode((authorizations[2] ?? '').replace('bearer ', ''));
    expect(decoded).toMatchObject({
      iss: 'TEAM123',
      iat: Math.floor(currentTime / 1000),
    });
  });

  it('re-signs the provider JWT after a backwards clock correction', async () => {
    let currentTime = Date.parse('2026-07-17T00:00:00.000Z');
    const authorizations: string[] = [];
    const request = vi.fn((input: { headers: Record<string, string> }) => {
      authorizations.push(input.headers.authorization ?? '');
      return Promise.resolve({ ok: true, status: 200 });
    });
    const client = createApnsClient(baseConfig, { now: () => currentTime, request });

    await client.send('aaaa', { aps: { alert: 'one' } });
    // Clock corrected backwards: the cached token would otherwise outlive its
    // real TTL and carry a future-relative iat.
    currentTime -= 10 * 60 * 1000;
    await client.send('bbbb', { aps: { alert: 'two' } });

    expect(authorizations[1]).not.toBe(authorizations[0]);
    const decoded = jwt.decode((authorizations[1] ?? '').replace('bearer ', ''));
    expect(decoded).toMatchObject({ iat: Math.floor(currentTime / 1000) });
  });

  it('sets apns-collapse-id only when a collapse id is provided', async () => {
    const headerSets: Record<string, string>[] = [];
    const request = vi.fn((input: { headers: Record<string, string> }) => {
      headerSets.push(input.headers);
      return Promise.resolve({ ok: true, status: 200 });
    });
    const client = createApnsClient(baseConfig, { request });

    await client.send('aaaa', { aps: {} }, { collapseId: 'outbox-row-1' });
    await client.send('aaaa', { aps: {} });

    expect(headerSets[0]?.['apns-collapse-id']).toBe('outbox-row-1');
    expect(headerSets[1]).not.toHaveProperty('apns-collapse-id');
  });

  it('rejects and destroys the session when APNs never responds (bounded deadline)', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const destroy = vi.fn();
    const stream = { setEncoding: vi.fn(), on: vi.fn(), once: vi.fn(), end: vi.fn() };
    const session = {
      once: vi.fn(),
      request: vi.fn(() => stream),
      destroy,
      close: vi.fn(),
      closed: false,
      destroyed: false,
    };
    vi.doMock('node:http2', () => ({ connect: vi.fn(() => session) }));
    try {
      const { createApnsClient: createReal } = await import('../../src/services/apns');
      // No injected request dependency: exercise the real HTTP/2 path.
      const client = createReal(baseConfig, {});

      const pending = client.send('aaaa', { aps: {} });
      const assertion = expect(pending).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(PUSH_POLICY.apnsRequestTimeoutMs + 1);
      await assertion;
      expect(destroy).toHaveBeenCalled();
    } finally {
      vi.doUnmock('node:http2');
      vi.useRealTimers();
      vi.resetModules();
    }
  });

  it('selects the production APNs endpoint', async () => {
    const request = vi.fn((input: { origin: string }) => {
      expect(input.origin).toBe('https://api.push.apple.com');
      return Promise.resolve({ ok: true, status: 200 });
    });
    const client = createApnsClient({ ...baseConfig, APNS_ENV: 'production' }, { request });

    await expect(client.send('aaaa', { aps: {} })).resolves.toEqual({ ok: true, status: 200 });
  });
});
