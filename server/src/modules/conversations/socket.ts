import { messageSendPayload, type MessageSendAck, type MessageSendError } from '@chat/shared';
import { AppError } from '../../errors.js';
import type { AppServer } from '../../io.js';
import { logger } from '../../logger.js';
import { socketReady } from '../presence/socket.js';
import * as conversations from './service.js';

const ackErrors = new Set<string>(['invalid_input', 'not_found', 'rate_limited']);

const toAckError = (err: unknown): MessageSendError => {
  if (err instanceof AppError && ackErrors.has(err.code)) return err.code as MessageSendError;
  logger.error({ err }, 'message:send failed');
  return 'internal';
};

// Rooms are joined only here and in the start DM route, never on a client request.
export function registerConversationSocket(io: AppServer): void {
  io.on('connection', (socket) => {
    const { userId } = socket.data;

    // Presence waits for the rooms: they are who hears this user came online.
    conversations
      .conversationIdsFor(userId)
      .then(async (ids) => {
        await socket.join(ids.map((id) => `conv:${id}`));
        if (socket.connected) await socketReady(io, userId, ids);
      })
      .catch((err: unknown) => logger.error({ err }, 'joining conversation rooms failed'));

    socket.on('message:send', async (payload, ack) => {
      const reply: (r: MessageSendAck) => void = typeof ack === 'function' ? ack : () => undefined;
      const parsed = messageSendPayload.safeParse(payload);
      if (!parsed.success) return reply({ ok: false, error: 'invalid_input' });
      try {
        const { message, created } = await conversations.sendMessage(userId, parsed.data);
        reply({ ok: true, message });
        if (created) socket.to(`conv:${message.conversationId}`).emit('message:new', message);
      } catch (err) {
        reply({ ok: false, error: toAckError(err) });
      }
    });
  });
}
