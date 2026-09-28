import { sql, type Kysely, type Transaction } from 'kysely';
import { db, type Database, type Role } from '../../db/index.js';

type Trx = Transaction<Database>;

export const transaction = <T>(fn: (trx: Trx) => Promise<T>) => db.transaction().execute(fn);

/** Locks the group row, so every change to one group runs one at a time. DMs never match. */
export const lockGroup = (trx: Trx, groupId: string) =>
  trx
    .selectFrom('conversations')
    .select(['id', 'name'])
    .where('id', '=', groupId)
    .where('type', '=', 'group')
    .forUpdate()
    .executeTakeFirst();

export const roleOf = async (trx: Trx, groupId: string, userId: string) =>
  (
    await trx
      .selectFrom('memberships')
      .select('role')
      .where('conversation_id', '=', groupId)
      .where('user_id', '=', userId)
      .executeTakeFirst()
  )?.role;

export const insertGroup = (
  trx: Trx,
  createdBy: string,
  name: string,
  avatarUrl: string | undefined,
) =>
  trx
    .insertInto('conversations')
    .values({ type: 'group', name, avatar_url: avatarUrl ?? null, created_by: createdBy })
    .returning('id')
    .executeTakeFirstOrThrow();

/**
 * Returns only the users actually added: people already in the group are skipped. New members
 * start with both marks at the latest message, so old history is not unread for them.
 */
export const insertMembers = async (
  trx: Trx,
  groupId: string,
  members: readonly { userId: string; role: Role }[],
) => {
  const latest = sql<
    string | null
  >`(SELECT max(id) FROM messages WHERE conversation_id = ${groupId})`;
  return (
    await trx
      .insertInto('memberships')
      .values(
        members.map((m) => ({
          conversation_id: groupId,
          user_id: m.userId,
          role: m.role,
          last_delivered_message_id: latest,
          last_read_message_id: latest,
        })),
      )
      .onConflict((oc) => oc.columns(['conversation_id', 'user_id']).doNothing())
      .returning('user_id')
      .execute()
  ).map((r) => r.user_id);
};

export const memberCount = async (trx: Trx, groupId: string) =>
  Number(
    (
      await trx
        .selectFrom('memberships')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('conversation_id', '=', groupId)
        .executeTakeFirstOrThrow()
    ).n,
  );

export const memberIds = async (trx: Trx, groupId: string) =>
  (
    await trx
      .selectFrom('memberships')
      .select('user_id')
      .where('conversation_id', '=', groupId)
      .execute()
  ).map((r) => r.user_id);

export const updateGroup = (
  trx: Trx,
  groupId: string,
  patch: { name?: string; avatarUrl?: string | null },
) =>
  trx
    .updateTable('conversations')
    .set({
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.avatarUrl === undefined ? {} : { avatar_url: patch.avatarUrl }),
    })
    .where('id', '=', groupId)
    .execute();

export const setRole = (trx: Trx, groupId: string, userId: string, role: Role) =>
  trx
    .updateTable('memberships')
    .set({ role })
    .where('conversation_id', '=', groupId)
    .where('user_id', '=', userId)
    .execute();

export const deleteMember = (trx: Trx, groupId: string, userId: string) =>
  trx
    .deleteFrom('memberships')
    .where('conversation_id', '=', groupId)
    .where('user_id', '=', userId)
    .execute();

// Memberships, messages and reactions go with it (ON DELETE CASCADE).
export const deleteGroup = (trx: Trx, groupId: string) =>
  trx.deleteFrom('conversations').where('id', '=', groupId).execute();

/** The group and its members, or undefined for a DM or an unknown id. */
export const detail = async (ex: Kysely<Database>, groupId: string) => {
  const group = await ex
    .selectFrom('conversations')
    .select(['id', 'name', 'avatar_url'])
    .where('id', '=', groupId)
    .where('type', '=', 'group')
    .executeTakeFirst();
  if (!group) return undefined;
  const members = await ex
    .selectFrom('memberships as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .select([
      'm.user_id',
      'm.role',
      'u.display_name',
      'm.last_delivered_message_id',
      'm.last_read_message_id',
    ])
    .where('m.conversation_id', '=', groupId)
    .execute();
  return { group, members };
};

export const readDetail = (groupId: string) => detail(db, groupId);
