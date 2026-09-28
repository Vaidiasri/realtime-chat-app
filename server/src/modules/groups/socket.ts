import type { z } from 'zod';
import {
  createGroupBody,
  groupAddPayload,
  groupMemberPayload,
  groupRefPayload,
  groupSetRolePayload,
  groupUpdatePayload,
  type GroupAck,
  type GroupError,
} from '@chat/shared';
import { AppError } from '../../errors.js';
import type { AppServer } from '../../io.js';
import { logger } from '../../logger.js';
import { summaryFor } from '../conversations/service.js';
import * as groups from './service.js';

/**
 * Runs after the commit. The server moving sockets out of the room is the cutoff; the events only
 * tell the UI. Order: tell and drop leavers, then join and tell newcomers, then update the rest.
 */
export async function publish(io: AppServer, change: groups.Change): Promise<void> {
  const room = `conv:${change.groupId}`;
  for (const { userId, reason } of change.left) {
    io.to(`user:${userId}`).emit('group:removed', {
      conversationId: change.groupId,
      name: change.name,
      reason,
    });
    io.in(`user:${userId}`).socketsLeave(room);
  }
  if (change.joined.length > 0) {
    io.in(change.joined.map((id) => `user:${id}`)).socketsJoin(room);
    await Promise.all(
      change.joined.map(async (id) => {
        try {
          io.to(`user:${id}`).emit('conversation:new', await summaryFor(id, change.groupId));
        } catch (err) {
          // The change is committed; a later sync shows it. Never fail the caller over this.
          logger.error({ err }, 'group conversation:new failed');
        }
      }),
    );
  }
  if (change.detail) io.to(room).emit('group:updated', change.detail);
}

const ackErrors = new Set<string>([
  'invalid_input',
  'not_found',
  'forbidden',
  'group_full',
  'owner_must_transfer',
]);

const toAckError = (err: unknown): GroupError => {
  if (err instanceof AppError && ackErrors.has(err.code)) return err.code as GroupError;
  logger.error({ err }, 'group socket call failed');
  return 'internal';
};

export function registerGroupSocket(io: AppServer): void {
  io.on('connection', (socket) => {
    const { userId } = socket.data;

    // Parse with the shared schema, call the service as the socket's verified user, publish.
    const run =
      <S extends z.ZodType>(schema: S, call: (data: z.infer<S>) => Promise<groups.Change>) =>
      async (payload: unknown, ack: unknown) => {
        const reply = typeof ack === 'function' ? (ack as (r: GroupAck) => void) : () => undefined;
        const parsed = schema.safeParse(payload);
        if (!parsed.success) return reply({ ok: false, error: 'invalid_input' });
        try {
          const change = await call(parsed.data);
          reply({ ok: true });
          await publish(io, change);
        } catch (err) {
          reply({ ok: false, error: toAckError(err) });
        }
      };

    socket.on(
      'group:create',
      run(createGroupBody, async (b) => (await groups.createGroup(userId, b)).change),
    );
    socket.on(
      'group:update',
      run(groupUpdatePayload, ({ conversationId, ...patch }) =>
        groups.updateGroup(userId, conversationId, patch),
      ),
    );
    socket.on(
      'group:addMembers',
      run(groupAddPayload, (p) => groups.addMembers(userId, p.conversationId, p.userIds)),
    );
    socket.on(
      'group:removeMember',
      run(groupMemberPayload, (p) => groups.removeMember(userId, p.conversationId, p.userId)),
    );
    socket.on(
      'group:setRole',
      run(groupSetRolePayload, (p) => groups.setRole(userId, p.conversationId, p.userId, p.role)),
    );
    socket.on(
      'group:transfer',
      run(groupMemberPayload, (p) => groups.transfer(userId, p.conversationId, p.userId)),
    );
    socket.on(
      'group:delete',
      run(groupRefPayload, (p) => groups.deleteGroup(userId, p.conversationId)),
    );
  });
}
