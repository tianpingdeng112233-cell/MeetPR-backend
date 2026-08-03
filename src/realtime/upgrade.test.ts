import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import jwt from 'jsonwebtoken';
import pino from 'pino';
import WebSocket, { type RawData, type WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { config, ids } from '../../tests/helpers/studentActions';
import { createRealtimeHub } from './hub';
import { attachRealtimeUpgrade, REALTIME_HEARTBEAT_INTERVAL_MS } from './upgrade';

const logger = pino({ level: 'silent' });

function frameText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString();
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString();
  return Buffer.concat(data).toString();
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: Server, wss: WebSocketServer): Promise<void> {
  wss.close();
  for (const socket of wss.clients) socket.terminate();
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
}

async function expectUnauthorized(url: string, authorization?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(
      url,
      authorization === undefined ? {} : { headers: { Authorization: authorization } },
    );
    let rejected = false;

    socket.once('open', () => {
      reject(new Error('unexpected websocket upgrade'));
    });
    socket.once('unexpected-response', (_request, response: IncomingMessage) => {
      rejected = true;
      expect(response.statusCode).toBe(401);
      response.resume();
      response.once('close', () => {
        expect(response.complete).toBe(true);
        resolve();
      });
    });
    socket.once('error', (error) => {
      if (!rejected) reject(error);
    });
  });
}

async function expectDestroyedWithoutResponse(url: string, authorization: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Authorization: authorization } });
    socket.once('open', () => {
      reject(new Error('unexpected websocket upgrade'));
    });
    socket.once('unexpected-response', () => {
      reject(new Error('unexpected HTTP response'));
    });
    socket.once('error', () => {
      resolve();
    });
  });
}

async function connect(url: string, authorization: string): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Authorization: authorization } });
    socket.once('error', reject);
    socket.once('message', (data) => {
      expect(JSON.parse(frameText(data))).toEqual({ type: 'hello', payload: {} });
      resolve(socket);
    });
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('realtime websocket upgrade', () => {
  it('rejects missing, bad, and refresh bearer tokens with 401 before upgrading', async () => {
    const server = createServer();
    const hub = createRealtimeHub({ logger });
    const wss = attachRealtimeUpgrade({ server, hub, config, logger });
    const port = await listen(server);
    const url = `ws://127.0.0.1:${String(port)}/realtime`;
    const refreshToken = jwt.sign(
      { sub: ids.trainee, role: 'coached_student', typ: 'refresh' },
      config.JWT_REFRESH_SECRET,
      {
        algorithm: 'HS256',
        expiresIn: '30d',
        issuer: 'meetpr-api',
        audience: 'meetpr-client',
      },
    );

    try {
      await expectUnauthorized(url);
      await expectUnauthorized(url, 'Bearer not-a-jwt');
      await expectUnauthorized(url, `Bearer ${refreshToken}`);
    } finally {
      await closeServer(server, wss);
    }
  });

  it('accepts only the exact /realtime path and sends hello to a valid access token', async () => {
    const server = createServer();
    const hub = createRealtimeHub({ logger });
    const wss = attachRealtimeUpgrade({ server, hub, config, logger });
    const port = await listen(server);
    const baseUrl = `ws://127.0.0.1:${String(port)}`;
    const authorization = `Bearer ${jwt.sign(
      { sub: ids.trainee, role: 'coached_student', typ: 'access' },
      config.JWT_ACCESS_SECRET,
      {
        algorithm: 'HS256',
        expiresIn: '15m',
        issuer: 'meetpr-api',
        audience: 'meetpr-client',
      },
    )}`;
    let socket: WebSocket | undefined;

    try {
      await expectDestroyedWithoutResponse(`${baseUrl}/realtime?query=1`, authorization);
      socket = await connect(`${baseUrl}/realtime`, authorization);
      expect(hub.connectionCount(ids.trainee)).toBe(1);
    } finally {
      socket?.terminate();
      await closeServer(server, wss);
    }
  });

  it('terminates a zombie socket within two 30-second heartbeat cycles', () => {
    vi.useFakeTimers();
    const server = createServer();
    const hub = createRealtimeHub({ logger });
    const wss = attachRealtimeUpgrade({ server, hub, config, logger });
    const ping = vi.fn();
    const terminate = vi.fn();
    const zombie = { ping, terminate } as unknown as WebSocket;
    wss.clients.add(zombie);

    vi.advanceTimersByTime(REALTIME_HEARTBEAT_INTERVAL_MS);
    expect(ping).toHaveBeenCalledOnce();
    expect(terminate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(REALTIME_HEARTBEAT_INTERVAL_MS);
    expect(terminate).toHaveBeenCalledOnce();

    wss.clients.delete(zombie);
    wss.close();
  });
});
