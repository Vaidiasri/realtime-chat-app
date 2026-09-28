import type { ReceiptMarkPayload, ReceiptUpdate } from '@chat/shared';
import * as q from './queries.js';

const MARK_LIMIT = 10;
const MARK_WINDOW_MS = 1_000;

const toUpdate = (userId: string, r: q.MarkRow): ReceiptUpdate => ({
  conversationId: r.conversation_id,
  userId,
  lastDeliveredId: r.last_delivered_message_id,
  lastReadId: r.last_read_message_id,
});

// ponytail: in memory fixed window per instance, like the send limit; shared store to scale out.
const windows = new Map<string, { count: number; resetAt: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [key, w] of windows) if (w.resetAt <= now) windows.delete(key);
}, 60_000).unref();

function takeSlot(userId: string): boolean {
  const now = Date.now();
  const w = windows.get(userId);
  if (!w || w.resetAt <= now) {
    windows.set(userId, { count: 1, resetAt: now + MARK_WINDOW_MS });
    return true;
  }
  if (w.count >= MARK_LIMIT) return false;
  windows.set(userId, { count: w.count + 1, resetAt: w.resetAt });
  return true;
}

/** Null when dropped: over the limit, not a member, or nothing moved. */
export async function mark(userId: string, p: ReceiptMarkPayload): Promise<ReceiptUpdate | null> {
  if (!takeSlot(userId)) return null;
  const row = await q.mark(userId, p.conversationId, p.messageId, p.kind === 'read');
  return row ? toUpdate(userId, row) : null;
}

export const catchUpDelivered = async (userId: string): Promise<ReceiptUpdate[]> =>
  (await q.catchUpDelivered(userId)).map((r) => toUpdate(userId, r));
