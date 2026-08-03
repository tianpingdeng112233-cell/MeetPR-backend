import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer, type WebSocket } from 'ws';

import type { Config } from '../config';
import type { Logger } from '../logger';
import { verifyBearerToken } from '../middleware/auth';
import { helloEvent } from './events';
import type { RealtimeHub } from './hub';

export const REALTIME_HEARTBEAT_INTERVAL_MS = 30_000;

interface AttachRealtimeUpgradeDeps {
  server: Server;
  hub: RealtimeHub;
  config: Config;
  logger: Logger;
}

const UNAUTHORIZED_RESPONSE =
  'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';

function rejectUnauthorized(socket: Duplex): void {
  socket.once('error', () => socket.destroy());
  socket.write(UNAUTHORIZED_RESPONSE, () => socket.destroy());
}

export function attachRealtimeUpgrade({
  server,
  hub,
  config,
  logger,
}: AttachRealtimeUpgradeDeps): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const isAlive = new WeakMap<WebSocket, boolean>();

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (request.url !== '/realtime') {
      socket.destroy();
      return;
    }

    // A future browser client can authenticate via Sec-WebSocket-Protocol;
    // this native-client wave intentionally accepts Authorization only.
    const user = verifyBearerToken(request.headers.authorization, config);
    if (!user) {
      logger.warn({ userId: null, connectionCount: 0 }, 'realtime_auth_reject');
      rejectUnauthorized(socket);
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      isAlive.set(ws, true);
      ws.on('pong', () => isAlive.set(ws, true));

      const connectionCount = hub.register(user.id, ws);
      logger.info({ userId: user.id, connectionCount }, 'realtime_connect');

      let registered = true;
      const cleanup = (): void => {
        if (!registered) return;
        registered = false;
        const remainingConnections = hub.unregister(user.id, ws);
        logger.info(
          { userId: user.id, connectionCount: remainingConnections },
          'realtime_disconnect',
        );
      };

      ws.once('close', cleanup);
      ws.once('error', (error) => {
        logger.warn({ err: error, userId: user.id, connectionCount }, 'realtime_socket_error');
        cleanup();
      });

      ws.send(JSON.stringify(helloEvent()), (error) => {
        if (error) {
          logger.warn({ err: error, userId: user.id }, 'realtime_send_error');
          ws.terminate();
        }
      });
    });
  };

  server.on('upgrade', onUpgrade);

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (isAlive.get(ws) === false) {
        ws.terminate();
        continue;
      }

      isAlive.set(ws, false);
      try {
        ws.ping();
      } catch (error: unknown) {
        logger.warn({ err: error }, 'realtime_ping_error');
        ws.terminate();
      }
    }
  }, REALTIME_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  wss.once('close', () => {
    clearInterval(heartbeat);
    server.off('upgrade', onUpgrade);
  });

  return wss;
}
