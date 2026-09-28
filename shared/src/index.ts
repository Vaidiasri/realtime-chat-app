import type { AuthRefreshAck, AuthRefreshPayload } from './auth.js';
import type {
  ConversationSummary,
  Message,
  MessageSendAck,
  MessageSendPayload,
} from './conversations.js';
import type { GroupAck, GroupDetail, GroupRemoved } from './groups.js';
import type { PresenceUpdate, TypingPayload, TypingUpdate } from './presence.js';
import type { ReceiptMarkPayload, ReceiptUpdate } from './receipts.js';

export * from './auth.js';
export * from './conversations.js';
export * from './groups.js';
export * from './presence.js';
export * from './receipts.js';

// Socket event contracts shared by client and server. Each feature adds its events here.
export interface ServerToClientEvents {
  'message:new': (m: Message) => void;
  'conversation:new': (c: ConversationSummary) => void;
  'group:updated': (g: GroupDetail) => void;
  'group:removed': (r: GroupRemoved) => void;
  'presence:update': (p: PresenceUpdate) => void;
  'typing:update': (t: TypingUpdate) => void;
  'receipt:update': (r: ReceiptUpdate) => void;
}

// Group payloads are validated on the server with the zod schemas in groups.ts.
type GroupCall<P> = (payload: P, ack: (r: GroupAck) => void) => void;
type Ref = { conversationId: string };

export interface ClientToServerEvents {
  'auth:refresh': (payload: AuthRefreshPayload, ack: (r: AuthRefreshAck) => void) => void;
  'message:send': (payload: MessageSendPayload, ack: (r: MessageSendAck) => void) => void;
  'group:create': GroupCall<{ name: string; avatarUrl?: string; memberIds?: string[] }>;
  'group:update': GroupCall<Ref & { name?: string; avatarUrl?: string | null }>;
  'group:addMembers': GroupCall<Ref & { userIds: string[] }>;
  'group:removeMember': GroupCall<Ref & { userId: string }>;
  'group:setRole': GroupCall<Ref & { userId: string; role: 'admin' | 'member' }>;
  'group:transfer': GroupCall<Ref & { userId: string }>;
  'group:delete': GroupCall<Ref>;
  'typing:start': (payload: TypingPayload) => void;
  'typing:stop': (payload: TypingPayload) => void;
  'receipt:mark': (payload: ReceiptMarkPayload) => void;
}

export interface HealthResponse {
  ok: boolean;
  db: 'up' | 'down';
}
