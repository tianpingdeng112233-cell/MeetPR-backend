import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import pino from 'pino';
import request from 'supertest';
import WebSocket, { type RawData, type WebSocketServer } from 'ws';
import { describe, expect, it } from 'vitest';

import type { RealtimeEvent } from '../src/realtime/events';
import { createRealtimeHub, type RealtimeHub } from '../src/realtime/hub';
import { attachRealtimeUpgrade } from '../src/realtime/upgrade';
import type { TestContext } from './helpers/studentActions';
import { auth, config, ids, makeContext } from './helpers/studentActions';

const logger = pino({ level: 'silent' });

interface RealtimeFixture {
  ctx: TestContext;
  conversationId: string;
  server: Server;
  wss: WebSocketServer;
  hub: RealtimeHub;
  student: WebSocket;
  coach: WebSocket;
}

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

async function connect(url: string, token: string): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, { headers: auth(token) });
    socket.once('error', reject);
    socket.once('message', (data) => {
      expect(JSON.parse(frameText(data))).toEqual({ type: 'hello', payload: {} });
      resolve(socket);
    });
  });
}

async function nextEvent(socket: WebSocket): Promise<RealtimeEvent> {
  return new Promise<RealtimeEvent>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('realtime event exceeded 1 second'));
    }, 1_000);
    socket.once('error', reject);
    socket.once('message', (data: RawData) => {
      clearTimeout(timeout);
      resolve(JSON.parse(frameText(data)) as RealtimeEvent);
    });
  });
}

async function expectNoEvent(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onMessage = (): void => {
      reject(new Error('unexpected realtime event'));
    };
    socket.once('message', onMessage);
    setTimeout(() => {
      socket.off('message', onMessage);
      resolve();
    }, 100);
  });
}

// The client-side close resolves when the client finishes its half of the
// closing handshake; the server's `close` listener (which unregisters from the
// hub) can run a tick later, so hub-count assertions must wait it out.
async function waitForConnectionCount(
  hub: RealtimeHub,
  userId: string,
  expected: number,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (hub.connectionCount(userId) !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(hub.connectionCount(userId)).toBe(expected);
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    socket.once('close', () => {
      resolve();
    });
    socket.close();
  });
}

async function startFixture(): Promise<RealtimeFixture> {
  const hub = createRealtimeHub({ logger });
  const ctx = await makeContext(logger, { hub });
  await ctx.db
    .updateTable('bind_requests')
    .set({ responded_at: new Date('2026-01-01T00:00:00.000Z') })
    .where('student_id', '=', ids.trainee)
    .execute();
  await ctx.db
    .updateTable('bind_requests')
    .set({ responded_at: new Date('2026-02-01T00:00:00.000Z') })
    .where('student_id', '=', ids.trainee)
    .where('coach_id', '=', ids.coach)
    .execute();
  const conversation = await ctx.db
    .insertInto('conversations')
    .values({ coach_id: ids.coach, student_id: ids.trainee })
    .returning('id')
    .executeTakeFirstOrThrow();

  const server = createServer(ctx.app);
  const wss = attachRealtimeUpgrade({ server, hub, config, logger });
  const port = await listen(server);
  const url = `ws://127.0.0.1:${String(port)}/realtime`;
  const [student, coach] = await Promise.all([
    connect(url, ctx.traineeToken),
    connect(url, ctx.coachToken),
  ]);

  return {
    ctx,
    conversationId: conversation.id,
    server,
    wss,
    hub,
    student,
    coach,
  };
}

async function closeFixture(fixture: RealtimeFixture): Promise<void> {
  fixture.wss.close();
  for (const socket of fixture.wss.clients) socket.terminate();
  await Promise.all([closeSocket(fixture.student), closeSocket(fixture.coach)]);
  await new Promise<void>((resolve) =>
    fixture.server.close(() => {
      resolve();
    }),
  );
}

async function sendStudentMessage(
  fixture: RealtimeFixture,
  clientId: string,
): Promise<request.Response> {
  return request(fixture.server)
    .post(`/conversations/${fixture.conversationId}/messages`)
    .set(auth(fixture.ctx.traineeToken))
    .send({ kind: 'text', body: 'realtime hello', client_id: clientId });
}

describe('conversation realtime publishing', () => {
  it('publishes a new student message to both participants within 1s and skips an idempotent replay', async () => {
    const fixture = await startFixture();
    try {
      const studentEvent = nextEvent(fixture.student);
      const coachEvent = nextEvent(fixture.coach);
      const response = await sendStudentMessage(fixture, 'realtime-message-1');
      expect(response.status).toBe(201);
      const message = (response.body as { message: { seq: number } }).message;
      const expected = {
        type: 'chat.message',
        payload: {
          conversation_id: fixture.conversationId,
          seq: message.seq,
          sender_id: ids.trainee,
        },
      };
      await expect(studentEvent).resolves.toEqual(expected);
      await expect(coachEvent).resolves.toEqual(expected);

      const noStudentEvent = expectNoEvent(fixture.student);
      const noCoachEvent = expectNoEvent(fixture.coach);
      const replay = await sendStudentMessage(fixture, 'realtime-message-1');
      expect(replay.status).toBe(200);
      await Promise.all([noStudentEvent, noCoachEvent]);
    } finally {
      await closeFixture(fixture);
    }
  });

  it('publishes a coach read cursor only to the student connection', async () => {
    const fixture = await startFixture();
    try {
      const studentMessageEvent = nextEvent(fixture.student);
      const coachMessageEvent = nextEvent(fixture.coach);
      const sent = await sendStudentMessage(fixture, 'realtime-read-source');
      await Promise.all([studentMessageEvent, coachMessageEvent]);
      const message = (sent.body as { message: { id: string; seq: number } }).message;

      const studentReadEvent = nextEvent(fixture.student);
      const noCoachReadEvent = expectNoEvent(fixture.coach);
      const response = await request(fixture.server)
        .post(`/conversations/${fixture.conversationId}/read`)
        .set(auth(fixture.ctx.coachToken))
        .send({ message_id: message.id });

      expect(response.status).toBe(200);
      await expect(studentReadEvent).resolves.toEqual({
        type: 'chat.read',
        payload: {
          conversation_id: fixture.conversationId,
          user_id: ids.coach,
          last_read_seq: message.seq,
        },
      });
      await noCoachReadEvent;
    } finally {
      await closeFixture(fixture);
    }
  });

  it('removes a disconnected user from the hub and safely publishes later messages', async () => {
    const fixture = await startFixture();
    try {
      await closeSocket(fixture.student);
      await waitForConnectionCount(fixture.hub, ids.trainee, 0);

      const coachEvent = nextEvent(fixture.coach);
      const response = await request(fixture.server)
        .post(`/conversations/${fixture.conversationId}/messages`)
        .set(auth(fixture.ctx.coachToken))
        .send({ kind: 'text', body: 'after disconnect', client_id: 'after-disconnect' });

      expect(response.status).toBe(201);
      await expect(coachEvent).resolves.toMatchObject({
        type: 'chat.message',
        payload: { conversation_id: fixture.conversationId, sender_id: ids.coach },
      });
      expect(fixture.hub.connectionCount(ids.trainee)).toBe(0);
    } finally {
      await closeFixture(fixture);
    }
  });
});
