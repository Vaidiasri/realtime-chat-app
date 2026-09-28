import { typingPayload, type PresenceUpdate } from '@chat/shared';
import type { AppServer } from '../../io.js';
import { logger } from '../../logger.js';
import { assertMember, conversationIdsFor } from '../conversations/service.js';
import * as presence from './service.js';

// io.to([]) would broadcast to everyone, so an empty audience sends nothing.
const tell = (io: AppServer, conversationIds: readonly string[], p: PresenceUpdate) => {
  if (conversationIds.length > 0)
    io.to(conversationIds.map((id) => `conv:${id}`)).emit('presence:update', p);
};

/** Called once a socket's conversation rooms are joined, so its contacts are its audience. */
export async function socketReady(io: AppServer, userId: string, conversationIds: string[]) {
  if (!presence.cameOnline(userId)) return;
  tell(io, conversationIds, { userId, online: true, lastSeenAt: await presence.lastSeen(userId) });
}

export function registerPresenceSocket(io: AppServer): void {
  const connected = (userId: string) =>
    (io.sockets.adapter.rooms.get(`user:${userId}`)?.size ?? 0) > 0;

  io.on('connection', (socket) => {
    const { userId } = socket.data;

    // Rooms are already left by `disconnect`, so the room size counts the other tabs.
    socket.on('disconnect', () => {
      if (connected(userId)) return;
      presence.wentAway(
        userId,
        () => connected(userId),
        (lastSeenAt) => {
          conversationIdsFor(userId).then(
            (ids) => tell(io, ids, { userId, online: false, lastSeenAt }),
            (err: unknown) => logger.error({ err }, 'presence offline failed'),
          );
        },
      );
    });

    // Fire and forget: the throttle runs before any DB call, and a non member is dropped silently.
    for (const kind of ['start', 'stop'] as const) {
      socket.on(`typing:${kind}`, async (payload) => {
        const parsed = typingPayload.safeParse(payload);
        if (!parsed.success) return;
        const { conversationId } = parsed.data;
        if (!presence.allowTyping(userId, conversationId, kind)) return;
        try {
          await assertMember(userId, conversationId);
        } catch {
          return;
        }
        socket
          .to(`conv:${conversationId}`)
          .emit('typing:update', { conversationId, userId, typing: kind === 'start' });
      });
    }
  });
}
