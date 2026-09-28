import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { can, type GroupAction, type Role } from '@chat/shared';
import { db, migrateToLatest } from '../src/db/index.js';
import * as groups from '../src/modules/groups/service.js';
import * as conversations from '../src/modules/conversations/service.js';

const roles: Role[] = ['owner', 'admin', 'member'];

describe('can() permission matrix', () => {
  // [action, actor, target, allowed]. Every actor and target pair is listed, so a change shows up.
  const table: [GroupAction, Role, Role | undefined, boolean][] = [
    ...roles.flatMap((a): [GroupAction, Role, undefined, boolean][] => [
      ['rename', a, undefined, a !== 'member'],
      ['add', a, undefined, a !== 'member'],
      ['leave', a, undefined, a !== 'owner'],
      ['delete', a, undefined, a === 'owner'],
    ]),
    ['remove', 'owner', 'owner', false],
    ['remove', 'owner', 'admin', true],
    ['remove', 'owner', 'member', true],
    ['remove', 'admin', 'owner', false],
    ['remove', 'admin', 'admin', false],
    ['remove', 'admin', 'member', true],
    ['remove', 'member', 'owner', false],
    ['remove', 'member', 'admin', false],
    ['remove', 'member', 'member', false],
    ...(['setRole', 'transfer'] as const).flatMap((act): [GroupAction, Role, Role, boolean][] =>
      roles.flatMap((a) =>
        roles.map((t): [GroupAction, Role, Role, boolean] => [
          act,
          a,
          t,
          a === 'owner' && t !== 'owner',
        ]),
      ),
    ),
  ];
  it.each(table)('%s by %s on %s is %s', (action, actor, target, allowed) => {
    expect(can(action, actor, target)).toBe(allowed);
  });
  it('remove without a target is refused', () => {
    expect(can('remove', 'owner')).toBe(false);
  });
});

// Users go straight into the table: the tests are about group rules, not signup.
const makeUser = async (name: string) =>
  (
    await db
      .insertInto('users')
      .values({
        email: `${name}.${randomUUID()}@test.dev`,
        password_hash: 'x',
        display_name: name,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => (e as { code?: string }).code ?? String(e),
  );
const roleOf = async (groupId: string, userId: string) =>
  (await groups.getDetail(userId, groupId)).members.find((m) => m.userId === userId)?.role;

let owner: string, admin: string, member: string, other: string, stranger: string;
let groupId: string;

beforeAll(async () => {
  await migrateToLatest();
  [owner, admin, member, other, stranger] = await Promise.all(
    ['owner', 'admin', 'member', 'other', 'stranger'].map(makeUser),
  );
  const { conversation } = await groups.createGroup(owner, {
    name: 'Team',
    memberIds: [admin, member, other],
  });
  groupId = conversation.id;
  await groups.setRole(owner, groupId, admin, 'admin');
});
afterAll(() => db.destroy());

describe('group rules in the service', () => {
  it('the creator is the owner, everyone else a member until promoted', async () => {
    expect(await roleOf(groupId, owner)).toBe('owner');
    expect(await roleOf(groupId, admin)).toBe('admin');
    expect(await roleOf(groupId, member)).toBe('member');
  });

  it('a non member gets not_found for every action, never forbidden', async () => {
    for (const run of [
      () => groups.getDetail(stranger, groupId),
      () => groups.updateGroup(stranger, groupId, { name: 'x' }),
      () => groups.addMembers(stranger, groupId, [stranger]),
      () => groups.removeMember(stranger, groupId, member),
      () => groups.setRole(stranger, groupId, member, 'admin'),
      () => groups.transfer(stranger, groupId, stranger),
      () => groups.deleteGroup(stranger, groupId),
    ]) {
      expect(await code(run())).toBe('not_found');
    }
  });

  it('an unknown group id is not_found too', async () => {
    expect(await code(groups.updateGroup(owner, randomUUID(), { name: 'x' }))).toBe('not_found');
  });

  it('a DM id cannot be used as a group', async () => {
    const { conversation } = await conversations.startDirect(owner, stranger);
    expect(await code(groups.addMembers(owner, conversation.id, [member]))).toBe('not_found');
  });

  it('a member can only send and read', async () => {
    expect(await code(groups.updateGroup(member, groupId, { name: 'x' }))).toBe('forbidden');
    expect(await code(groups.addMembers(member, groupId, [stranger]))).toBe('forbidden');
    expect(await code(groups.removeMember(member, groupId, other))).toBe('forbidden');
    expect(await code(groups.setRole(member, groupId, other, 'admin'))).toBe('forbidden');
    expect(await code(groups.transfer(member, groupId, member))).toBe('forbidden');
    expect(await code(groups.deleteGroup(member, groupId))).toBe('forbidden');
    const sent = await conversations.sendMessage(member, {
      conversationId: groupId,
      clientId: randomUUID(),
      body: 'hello',
    });
    expect(sent.created).toBe(true);
  });

  it('an admin renames, adds and removes members, but not admins or the owner', async () => {
    expect(await code(groups.updateGroup(admin, groupId, { name: 'Renamed' }))).toBe('ok');
    expect(await code(groups.addMembers(admin, groupId, [stranger]))).toBe('ok');
    expect(await code(groups.removeMember(admin, groupId, stranger))).toBe('ok');
    expect(await code(groups.removeMember(admin, groupId, owner))).toBe('forbidden');
    expect(await code(groups.setRole(admin, groupId, member, 'admin'))).toBe('forbidden');
    expect(await code(groups.transfer(admin, groupId, admin))).toBe('forbidden');
    expect(await code(groups.deleteGroup(admin, groupId))).toBe('forbidden');
  });

  it('an admin cannot remove another admin', async () => {
    await groups.setRole(owner, groupId, other, 'admin');
    expect(await code(groups.removeMember(admin, groupId, other))).toBe('forbidden');
    await groups.setRole(owner, groupId, other, 'member');
  });

  it('adding an unknown user is not_found and adds nobody', async () => {
    const before = (await groups.getDetail(owner, groupId)).members.length;
    expect(await code(groups.addMembers(owner, groupId, [randomUUID()]))).toBe('not_found');
    expect((await groups.getDetail(owner, groupId)).members.length).toBe(before);
  });

  it('a removed member loses access at once', async () => {
    await groups.addMembers(owner, groupId, [stranger]);
    await groups.removeMember(owner, groupId, stranger);
    expect(await code(conversations.assertMember(stranger, groupId))).toBe('not_found');
    const send = conversations.sendMessage(stranger, {
      conversationId: groupId,
      clientId: randomUUID(),
      body: 'still here?',
    });
    expect(await code(send)).toBe('not_found');
    expect(await code(conversations.history(stranger, groupId, {}))).toBe('not_found');
  });

  it('the owner cannot leave without transferring, anyone else can', async () => {
    expect(await code(groups.removeMember(owner, groupId, owner))).toBe('owner_must_transfer');
    await groups.addMembers(owner, groupId, [stranger]);
    const change = await groups.removeMember(stranger, groupId, stranger);
    expect(change.left).toEqual([{ userId: stranger, reason: 'left' }]);
  });

  it('the owner cannot change their own role', async () => {
    expect(await code(groups.setRole(owner, groupId, owner, 'member'))).toBe('invalid_input');
  });

  it('transfer makes the old owner an admin, and only the new owner can delete', async () => {
    await groups.transfer(owner, groupId, member);
    expect(await roleOf(groupId, member)).toBe('owner');
    expect(await roleOf(groupId, owner)).toBe('admin');
    expect(await code(groups.deleteGroup(owner, groupId))).toBe('forbidden');
    const owners = (await groups.getDetail(member, groupId)).members.filter(
      (m) => m.role === 'owner',
    );
    expect(owners).toHaveLength(1);
    const change = await groups.deleteGroup(member, groupId);
    expect(change.left.every((l) => l.reason === 'deleted')).toBe(true);
    expect(await code(groups.getDetail(member, groupId))).toBe('not_found');
  });
});
