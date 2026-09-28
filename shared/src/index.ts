import type { AuthRefreshAck, AuthRefreshPayload } from './auth.js';
import type {
  ConversationSummary,
  Message,
  MessageSendAck,
  MessageSendPayload,
} from './conversations.js';

export * from './auth.js';
export * from './conversations.js';

// Socket event contracts shared by client and server. Each feature adds its events here.
export interface ServerToClientEvents {
  'message:new': (m: Message) => void;
  'conversation:new': (c: ConversationSummary) => void;
}

export interface ClientToServerEvents {
  'auth:refresh': (payload: AuthRefreshPayload, ack: (r: AuthRefreshAck) => void) => void;
  'message:send': (payload: MessageSendPayload, ack: (r: MessageSendAck) => void) => void;
}

export interface HealthResponse {
  ok: boolean;
  db: 'up' | 'down';
}
