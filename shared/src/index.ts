// Socket event contracts shared by client and server. Each feature adds its events here.
export interface ServerToClientEvents {}

export interface ClientToServerEvents {}

export interface HealthResponse {
  ok: boolean;
  db: 'up' | 'down';
}
