import type { AuthRefreshAck, AuthRefreshPayload } from './auth.js';

export * from './auth.js';

// Socket event contracts shared by client and server. Each feature adds its events here.
export interface ServerToClientEvents {}

export interface ClientToServerEvents {
  'auth:refresh': (payload: AuthRefreshPayload, ack: (r: AuthRefreshAck) => void) => void;
}

export interface HealthResponse {
  ok: boolean;
  db: 'up' | 'down';
}
