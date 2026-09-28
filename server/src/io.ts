import type { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@chat/shared';

export interface SocketData {
  userId: string;
  sid: string;
  exp: number;
}

export type AppServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;
