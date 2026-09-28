import { receiptMarkPayload } from '@chat/shared';
import type { AppServer } from '../../io.js';
import { logger } from '../../logger.js';
import * as receipts from './service.js';

export function registerReceiptSocket(io: AppServer): void {
  io.on('connection', (socket) => {
    const { userId } = socket.data;
    // No ack. Bad payloads, non members and floods are dropped silently.
    socket.on('receipt:mark', async (payload) => {
      const parsed = receiptMarkPayload.safeParse(payload);
      if (!parsed.success) return;
      try {
        const r = await receipts.mark(userId, parsed.data);
        // io, not socket: the reader's other tabs clear their badge too.
        if (r) io.to(`conv:${r.conversationId}`).emit('receipt:update', r);
      } catch (err) {
        logger.error({ err }, 'receipt:mark failed');
      }
    });
  });
}
