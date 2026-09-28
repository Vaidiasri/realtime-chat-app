import { z } from 'zod';
import { messageId } from './conversations.js';

// Fire and forget, no ack: a lost mark is corrected by the next one or the reconnect refetch.
export const receiptMarkPayload = z.object({
  conversationId: z.uuid(),
  messageId,
  kind: z.enum(['delivered', 'read']),
});
export type ReceiptMarkPayload = z.infer<typeof receiptMarkPayload>;

/** One member's marks in one conversation. A message is delivered or read up to these ids. */
export interface ReceiptUpdate {
  conversationId: string;
  userId: string;
  lastDeliveredId: string | null;
  lastReadId: string | null;
}
