import express from 'express';
import {
  addMembersBody,
  conversationIdParam,
  createGroupBody,
  memberParam,
  setRoleBody,
  transferBody,
  updateGroupBody,
} from '@chat/shared';
import { AppError } from '../../errors.js';
import { parse, userOf } from '../../http.js';
import type { AppServer } from '../../io.js';
import * as groups from './service.js';
import { publish } from './socket.js';

// A malformed id is a 404 like any other id the caller cannot see.
const idOf = (req: express.Request) =>
  parse(conversationIdParam, req.params, new AppError('not_found', 404)).id;
const memberOf = (req: express.Request) =>
  parse(memberParam, req.params, new AppError('not_found', 404));

/** Mounted under /api/conversations, beside the conversations router. */
export function groupsRouter(io: AppServer): express.Router {
  const router = express.Router();

  router.post('/groups', async (req, res) => {
    const { conversation, change } = await groups.createGroup(
      userOf(req).id,
      parse(createGroupBody, req.body),
    );
    await publish(io, change);
    res.status(201).json({ conversation });
  });

  router.get('/:id/members', async (req, res) => {
    res.json({ group: await groups.getDetail(userOf(req).id, idOf(req)) });
  });

  router.patch('/:id', async (req, res) => {
    const id = idOf(req);
    const change = await groups.updateGroup(userOf(req).id, id, parse(updateGroupBody, req.body));
    await publish(io, change);
    res.json({ group: change.detail });
  });

  router.delete('/:id', async (req, res) => {
    await publish(io, await groups.deleteGroup(userOf(req).id, idOf(req)));
    res.status(204).end();
  });

  router.post('/:id/members', async (req, res) => {
    const id = idOf(req);
    const { userIds } = parse(addMembersBody, req.body);
    const change = await groups.addMembers(userOf(req).id, id, userIds);
    await publish(io, change);
    res.json({ group: change.detail });
  });

  router.delete('/:id/members/:userId', async (req, res) => {
    const { id, userId } = memberOf(req);
    await publish(io, await groups.removeMember(userOf(req).id, id, userId));
    res.status(204).end();
  });

  router.patch('/:id/members/:userId', async (req, res) => {
    const { id, userId } = memberOf(req);
    const { role } = parse(setRoleBody, req.body);
    const change = await groups.setRole(userOf(req).id, id, userId, role);
    await publish(io, change);
    res.json({ group: change.detail });
  });

  router.post('/:id/transfer', async (req, res) => {
    const id = idOf(req);
    const { userId } = parse(transferBody, req.body);
    const change = await groups.transfer(userOf(req).id, id, userId);
    await publish(io, change);
    res.json({ group: change.detail });
  });

  return router;
}
