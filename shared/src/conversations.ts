import { z } from 'zod';
import type { GroupSummary } from './groups.js';

// Message ids are Postgres bigints, which pg returns as strings. Never convert them to numbers.
export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  clientId: string;
  /** Empty once deleted: `deletedAt` is set and the text is gone from the database. */
  body: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  reactions: Reaction[];
}

/** One emoji on one message, with who added it in the order they did. */
export interface Reaction {
  emoji: string;
  userIds: string[];
}

// Thumbs up, heart, laughing, surprised, sad, thanks.
export const REACTIONS = [
  '\u{1F44D}',
  '\u2764\uFE0F',
  '\u{1F602}',
  '\u{1F62E}',
  '\u{1F622}',
  '\u{1F64F}',
] as const;
/** Only the sender can delete for everyone, and only this long after sending. */
export const DELETE_WINDOW_MS = 10 * 60_000;

export interface UserSummary {
  id: string;
  displayName: string;
  email: string;
}

export interface DirectSummary {
  id: string;
  type: 'direct';
  peer: {
    id: string;
    displayName: string;
    online: boolean;
    lastSeenAt: string | null;
    lastDeliveredId: string | null;
    lastReadId: string | null;
  };
  latestMessage: Message | null;
  unreadCount: number;
  createdAt: string;
}

export type ConversationSummary = DirectSummary | GroupSummary;

export const searchQuery = z.object({ q: z.string().trim().min(2).max(100) });
export const startDirectBody = z.object({ userId: z.uuid() });
export const conversationIdParam = z.object({ id: z.uuid() });

// A positive bigint as a string, so it compares in SQL and never loses precision in JS.
export const messageId = z.string().regex(/^[1-9][0-9]{0,18}$/);
/** History paging: `before` walks older, `after` fills a gap; never both. */
export const historyQuery = z
  .object({ before: messageId.optional(), after: messageId.optional() })
  .refine((q) => !(q.before && q.after));
export type HistoryQuery = z.infer<typeof historyQuery>;

const messageBody = z.string().trim().min(1).max(4000);
export const messageSendPayload = z.object({
  conversationId: z.uuid(),
  clientId: z.uuid(),
  body: messageBody,
});
export type MessageSendPayload = z.infer<typeof messageSendPayload>;

export type MessageSendError = 'invalid_input' | 'not_found' | 'rate_limited' | 'internal';
export type MessageSendAck =
  { ok: true; message: Message } | { ok: false; error: MessageSendError };

export const messageEditPayload = z.object({ messageId, body: messageBody });
export const messageDeletePayload = z.object({ messageId });
export const messageReactPayload = z.object({
  messageId,
  emoji: z.enum(REACTIONS),
  on: z.boolean(),
});
export type MessageEditPayload = z.infer<typeof messageEditPayload>;
export type MessageDeletePayload = z.infer<typeof messageDeletePayload>;
export type MessageReactPayload = z.infer<typeof messageReactPayload>;

export type MessageActionError =
  'invalid_input' | 'not_found' | 'forbidden' | 'too_late' | 'rate_limited' | 'internal';
export type MessageActionAck =
  { ok: true; message: Message } | { ok: false; error: MessageActionError };

export interface UsersResponse {
  users: UserSummary[];
}
export interface ConversationResponse {
  conversation: ConversationSummary;
}
export interface ConversationsResponse {
  conversations: ConversationSummary[];
}
/** Always oldest first. `hasMore`: more rows exist past this page in the paging direction. */
export interface MessagesResponse {
  messages: Message[];
  hasMore: boolean;
}
