import WebSocket from 'ws';

import type { Logger } from '../logger';
import type { RealtimeEvent } from './events';

/**
 * This process-local registry deliberately assumes a single backend instance.
 * Before scaling horizontally, persisted events must be broadcast between
 * instances (for example with PostgreSQL LISTEN/NOTIFY) and then fanned out by
 * each instance's local hub.
 */
export interface RealtimeHub {
  register(userId: string, socket: WebSocket): number;
  unregister(userId: string, socket: WebSocket): number;
  publish(userId: string, event: RealtimeEvent): void;
  connectionCount(userId: string): number;
}

interface RealtimeHubDeps {
  logger: Logger;
}

export function createRealtimeHub({ logger }: RealtimeHubDeps): RealtimeHub {
  const socketsByUser = new Map<string, Set<WebSocket>>();

  return {
    register(userId, socket) {
      let sockets = socketsByUser.get(userId);
      if (!sockets) {
        sockets = new Set();
        socketsByUser.set(userId, sockets);
      }
      sockets.add(socket);
      return sockets.size;
    },

    unregister(userId, socket) {
      const sockets = socketsByUser.get(userId);
      if (!sockets) return 0;

      sockets.delete(socket);
      if (sockets.size === 0) {
        socketsByUser.delete(userId);
        return 0;
      }
      return sockets.size;
    },

    publish(userId, event) {
      const sockets = socketsByUser.get(userId);
      if (!sockets) return;

      const frame = JSON.stringify(event);
      for (const socket of sockets) {
        if (socket.readyState !== WebSocket.OPEN) continue;
        try {
          socket.send(frame, (error) => {
            if (error) {
              logger.warn({ err: error, userId, eventType: event.type }, 'realtime_send_error');
            }
          });
        } catch (error: unknown) {
          logger.warn({ err: error, userId, eventType: event.type }, 'realtime_send_error');
        }
      }
    },

    connectionCount(userId) {
      return socketsByUser.get(userId)?.size ?? 0;
    },
  };
}
