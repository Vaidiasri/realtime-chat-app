import { z } from 'zod';

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

export interface ConversationSummary {
  id: string;
  type: 'direct';
  peer: { id: string; displayName: string };
  latestMessage: Message | null;
  createdAt: string;
}

export const searchQuery = z.object({ q: z.string().trim().min(2).max(100) });
export const startDirectBody = z.object({ userId: z.uuid() });
export const conversationIdParam = z.object({ id: z.uuid() });

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
export interface MessagesResponse {
  messages: Message[];
}
