import express from 'express';
import { conversationIdParam, startDirectBody } from '@chat/shared';
import { AppError } from '../../errors.js';
import { parse, userOf } from '../../http.js';
import type { AppServer } from '../../io.js';
import * as conversations from './service.js';

export function conversationsRouter(io: AppServer): express.Router {
  const router = express.Router();

  router.post('/direct', async (req, res) => {
    const me = userOf(req).id;
    const { userId } = parse(startDirectBody, req.body);
    const { conversation, created } = await conversations.startDirect(me, userId);
    if (created) {
      // Only a new DM changes membership: both users' online sockets join, and both sidebars
      // learn about it, each with its own peer.
      const room = `conv:${conversation.id}`;
      io.in([`user:${me}`, `user:${userId}`]).socketsJoin(room);
      io.to(`user:${me}`).emit('conversation:new', conversation);
      io.to(`user:${userId}`).emit(
        'conversation:new',
        await conversations.summaryFor(userId, conversation.id),
      );
    }
    res.status(created ? 201 : 200).json({ conversation });
  });

  router.get('/', async (req, res) => {
    res.json({ conversations: await conversations.listConversations(userOf(req).id) });
  });

  // A malformed id is a 404 like any other id the caller cannot see.
  router.get('/:id/messages', async (req, res) => {
    const { id } = parse(conversationIdParam, req.params, new AppError('not_found', 404));
    res.json({ messages: await conversations.history(userOf(req).id, id) });
  });

  return router;
}
