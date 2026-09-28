import {
  can,
  GROUP_MAX_MEMBERS,
  type CreateGroupBody,
  type GroupDetail,
  type GroupMember,
  type GroupRemoved,
  type GroupSummary,
  type Role,
} from '@chat/shared';
import { AppError } from '../../errors.js';
import { assertMember, summaryFor } from '../conversations/service.js';
import * as q from './queries.js';

/** What a mutation changed, for `publish` to turn into room moves and events after the commit. */
export interface Change {
  groupId: string;
  name: string;
  detail: GroupDetail | null;
  joined: readonly string[];
  left: readonly { userId: string; reason: GroupRemoved['reason'] }[];
}

type Trx = Parameters<Parameters<typeof q.transaction>[0]>[0];

const notFound = () => new AppError('not_found', 404);
const forbidden = () => new AppError('forbidden', 403);

const roleOrder: Record<Role, number> = { owner: 0, admin: 1, member: 2 };

const toDetail = (d: NonNullable<Awaited<ReturnType<typeof q.detail>>>): GroupDetail => ({
  id: d.group.id,
  name: d.group.name ?? '',
  avatarUrl: d.group.avatar_url,
  members: d.members
    .map((m): GroupMember => ({
      userId: m.user_id,
      displayName: m.display_name,
      role: m.role,
      lastDeliveredId: m.last_delivered_message_id,
      lastReadId: m.last_read_message_id,
    }))
    .sort(
      (a, b) => roleOrder[a.role] - roleOrder[b.role] || a.displayName.localeCompare(b.displayName),
    ),
});

const detailIn = async (trx: Trx, groupId: string) => {
  const d = await q.detail(trx, groupId);
  if (!d) throw notFound();
  return toDetail(d);
};

// Only the membership insert can hit a FK here (an unknown user id). Keep it tied to that call.
const fkIsNotFound = (err: unknown): never => {
  if ((err as { code?: unknown }).code === '23503') throw notFound();
  throw err;
};

/**
 * Every group mutation: lock the group row, read the actor's role, then run `fn`, all in one
 * transaction. A non member, a DM id and an unknown id all get the same 404.
 */
function withGroup<T>(
  actorId: string,
  groupId: string,
  fn: (trx: Trx, actorRole: Role, name: string) => Promise<T>,
): Promise<T> {
  return q.transaction(async (trx) => {
    const group = await q.lockGroup(trx, groupId);
    if (!group) throw notFound();
    const role = await q.roleOf(trx, groupId, actorId);
    if (!role) throw notFound();
    return fn(trx, role, group.name ?? '');
  });
}

/** The target's role, read under the same lock. Yourself needs no second read. */
const targetRole = async (
  trx: Trx,
  groupId: string,
  actorId: string,
  actorRole: Role,
  id: string,
) => {
  const role = id === actorId ? actorRole : await q.roleOf(trx, groupId, id);
  if (!role) throw notFound();
  return role;
};

export async function createGroup(
  actorId: string,
  body: CreateGroupBody,
): Promise<{ conversation: GroupSummary; change: Change }> {
  const others = [...new Set(body.memberIds)].filter((id) => id !== actorId);
  const groupId = await q.transaction(async (trx) => {
    const { id } = await q.insertGroup(trx, actorId, body.name, body.avatarUrl);
    await q
      .insertMembers(trx, id, [
        { userId: actorId, role: 'owner' },
        ...others.map((userId) => ({ userId, role: 'member' as const })),
      ])
      .catch(fkIsNotFound);
    return id;
  });
  const conversation = (await summaryFor(actorId, groupId)) as GroupSummary;
  return {
    conversation,
    change: { groupId, name: body.name, detail: null, joined: [actorId, ...others], left: [] },
  };
}

/** Members only, no lock. A DM id is 404 like any id that is not a group you are in. */
export async function getDetail(actorId: string, groupId: string): Promise<GroupDetail> {
  await assertMember(actorId, groupId);
  const d = await q.readDetail(groupId);
  if (!d) throw notFound();
  return toDetail(d);
}

export const updateGroup = (
  actorId: string,
  groupId: string,
  patch: { name?: string; avatarUrl?: string | null },
): Promise<Change> =>
  withGroup(actorId, groupId, async (trx, role) => {
    if (!can('rename', role)) throw forbidden();
    await q.updateGroup(trx, groupId, patch);
    const detail = await detailIn(trx, groupId);
    return { groupId, name: detail.name, detail, joined: [], left: [] };
  });

export const addMembers = (
  actorId: string,
  groupId: string,
  userIds: readonly string[],
): Promise<Change> =>
  withGroup(actorId, groupId, async (trx, role, name) => {
    if (!can('add', role)) throw forbidden();
    const joined = await q
      .insertMembers(
        trx,
        groupId,
        [...new Set(userIds)].map((userId) => ({ userId, role: 'member' as const })),
      )
      .catch(fkIsNotFound);
    // Unknown ids fail above first, so a 404 wins over the cap. Throwing rolls the insert back.
    if ((await q.memberCount(trx, groupId)) > GROUP_MAX_MEMBERS) {
      throw new AppError('group_full', 409);
    }
    return { groupId, name, detail: await detailIn(trx, groupId), joined, left: [] };
  });

/** Removing yourself is leaving. */
export const removeMember = (actorId: string, groupId: string, userId: string): Promise<Change> =>
  withGroup(actorId, groupId, async (trx, role, name) => {
    const self = userId === actorId;
    if (self) {
      if (!can('leave', role)) throw new AppError('owner_must_transfer', 409);
    } else if (!can('remove', role, await targetRole(trx, groupId, actorId, role, userId))) {
      throw forbidden();
    }
    await q.deleteMember(trx, groupId, userId);
    return {
      groupId,
      name,
      detail: await detailIn(trx, groupId),
      joined: [],
      left: [{ userId, reason: self ? 'left' : 'removed' }],
    };
  });

export const setRole = (
  actorId: string,
  groupId: string,
  userId: string,
  newRole: 'admin' | 'member',
): Promise<Change> =>
  withGroup(actorId, groupId, async (trx, role, name) => {
    const target = await targetRole(trx, groupId, actorId, role, userId);
    if (role === 'owner' && target === 'owner') throw new AppError('invalid_input', 400);
    if (!can('setRole', role, target)) throw forbidden();
    await q.setRole(trx, groupId, userId, newRole);
    return { groupId, name, detail: await detailIn(trx, groupId), joined: [], left: [] };
  });

export const transfer = (actorId: string, groupId: string, userId: string): Promise<Change> =>
  withGroup(actorId, groupId, async (trx, role, name) => {
    const target = await targetRole(trx, groupId, actorId, role, userId);
    if (role === 'owner' && target === 'owner') throw new AppError('invalid_input', 400);
    if (!can('transfer', role, target)) throw forbidden();
    // Demote first: the partial unique index allows only one owner row at any moment.
    await q.setRole(trx, groupId, actorId, 'admin');
    await q.setRole(trx, groupId, userId, 'owner');
    return { groupId, name, detail: await detailIn(trx, groupId), joined: [], left: [] };
  });

export const deleteGroup = (actorId: string, groupId: string): Promise<Change> =>
  withGroup(actorId, groupId, async (trx, role, name) => {
    if (!can('delete', role)) throw forbidden();
    const members = await q.memberIds(trx, groupId);
    await q.deleteGroup(trx, groupId);
    return {
      groupId,
      name,
      detail: null,
      joined: [],
      left: members.map((userId) => ({ userId, reason: 'deleted' as const })),
    };
  });
