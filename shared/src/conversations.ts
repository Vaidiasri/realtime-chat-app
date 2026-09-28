import { z } from 'zod';
import type { GroupSummary } from './groups.js';

// Message ids are Postgres bigints, which pg returns as strings. Never convert them to numbers.
export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  clientId: string;
  body: string;
  createdAt: string;
}

export interface UserSummary {
  id: string;
  displayName: string;
  email: string;
}

export interface DirectSummary {
  id: string;
  type: 'direct';
  peer: { id: string; displayName: string };
  latestMessage: Message | null;
  createdAt: string;
}

export type ConversationSummary = DirectSummary | GroupSummary;

export const searchQuery = z.object({ q: z.string().trim().min(2).max(100) });
export const startDirectBody = z.object({ userId: z.uuid() });
export const conversationIdParam = z.object({ id: z.uuid() });

// A positive bigint as a string, so it compares in SQL and never loses precision in JS.
const messageId = z.string().regex(/^[1-9][0-9]{0,18}$/);
/** History paging: `before` walks older, `after` fills a gap; never both. */
export const historyQuery = z
  .object({ before: messageId.optional(), after: messageId.optional() })
  .refine((q) => !(q.before && q.after));
export type HistoryQuery = z.infer<typeof historyQuery>;

export const messageSendPayload = z.object({
  conversationId: z.uuid(),
  clientId: z.uuid(),
  body: z.string().trim().min(1).max(4000),
});
export type MessageSendPayload = z.infer<typeof messageSendPayload>;

export type MessageSendError = 'invalid_input' | 'not_found' | 'rate_limited' | 'internal';
export type MessageSendAck =
  { ok: true; message: Message } | { ok: false; error: MessageSendError };

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
