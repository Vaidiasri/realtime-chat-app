import { z } from 'zod';

// Typing events carry no ack: a dropped one costs nothing.
export const typingPayload = z.object({ conversationId: z.uuid() });
export type TypingPayload = z.infer<typeof typingPayload>;

export interface PresenceUpdate {
  userId: string;
  online: boolean;
  lastSeenAt: string | null;
}

export interface TypingUpdate {
  conversationId: string;
  userId: string;
  typing: boolean;
}
