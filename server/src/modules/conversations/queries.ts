import { sql } from 'kysely';
import { db } from '../../db/index.js';
import { AppError } from '../../errors.js';

const messageColumns = [
  'id',
  'conversation_id',
  'sender_id',
  'client_id',
  'body',
  'created_at',
  'edited_at',
  'deleted_at',
] as const;

// Messages from others after my read mark. Deleted ones (null body) do not count.
const unreadCount = sql<string>`(
  SELECT count(*) FROM messages um
  WHERE um.conversation_id = c.id AND um.sender_id <> me.user_id AND um.deleted_at IS NULL
    AND um.id > coalesce(me.last_read_message_id, 0)
)`.as('unread_count');

export const conversationIdsFor = async (userId: string) =>
  (
    await db
      .selectFrom('memberships')
      .select('conversation_id')
      .where('user_id', '=', userId)
      .execute()
  ).map((r) => r.conversation_id);

export const isMember = async (userId: string, conversationId: string) =>
  (await db
    .selectFrom('memberships')
    .select('user_id')
    .where('conversation_id', '=', conversationId)
    .where('user_id', '=', userId)
    .executeTakeFirst()) !== undefined;

// The (sender_id, client_id) UNIQUE constraint decides idempotency: a retry returns the stored row.
// A new message claims its upload in the same transaction; a claim that matches nothing (someone
// else's file, another conversation, already sent) rolls the message back.
export const insertMessage = (
  senderId: string,
  conversationId: string,
  clientId: string,
  body: string,
  attachmentId?: string,
) =>
  db.transaction().execute(async (trx) => {
    const inserted = await trx
      .insertInto('messages')
      .values({ conversation_id: conversationId, sender_id: senderId, client_id: clientId, body })
      .onConflict((oc) => oc.columns(['sender_id', 'client_id']).doNothing())
      .returning(messageColumns)
      .executeTakeFirst();
    if (!inserted) {
      const row = await trx
        .selectFrom('messages')
        .select(messageColumns)
        .where('sender_id', '=', senderId)
        .where('client_id', '=', clientId)
        .executeTakeFirstOrThrow();
      return { row, created: false };
    }
    if (attachmentId) {
      const claimed = await trx
        .updateTable('attachments')
        .set({ message_id: inserted.id })
        .where('id', '=', attachmentId)
        .where('uploader_id', '=', senderId)
        .where('conversation_id', '=', conversationId)
        .where('message_id', 'is', null)
        .executeTakeFirst();
      if (claimed.numUpdatedRows === 0n) throw new AppError('invalid_input', 400);
    }
    return { row: inserted, created: true };
  });

// One transaction. The direct_key UNIQUE constraint makes concurrent starts create one row:
// the loser's ON CONFLICT waits for the winner's commit, then selects the winner's id.
export const startDirect = (me: string, other: string, directKey: string) =>
  db.transaction().execute(async (trx) => {
    const created = await trx
      .insertInto('conversations')
      .values({ type: 'direct', direct_key: directKey, created_by: me })
      .onConflict((oc) => oc.column('direct_key').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!created) {
      const existing = await trx
        .selectFrom('conversations')
        .select('id')
        .where('direct_key', '=', directKey)
        .executeTakeFirstOrThrow();
      return { id: existing.id, created: false };
    }
    await trx
      .insertInto('memberships')
      .values([
        { conversation_id: created.id, user_id: me },
        { conversation_id: created.id, user_id: other },
      ])
      .execute();
    return { id: created.id, created: true };
  });

/** Direct conversation rows for one user, with the peer and the newest message. */
export const summaries = (userId: string, conversationId?: string) => {
  let query = db
    .selectFrom('memberships as me')
    .innerJoin('conversations as c', 'c.id', 'me.conversation_id')
    .innerJoin('memberships as pm', (j) =>
      j.onRef('pm.conversation_id', '=', 'c.id').onRef('pm.user_id', '<>', 'me.user_id'),
    )
    .innerJoin('users as u', 'u.id', 'pm.user_id')
    .leftJoinLateral(
      (eb) =>
        eb
          .selectFrom('messages as m')
          .select(messageColumns)
          .whereRef('m.conversation_id', '=', 'c.id')
          .orderBy('m.id', 'desc')
          .limit(1)
          .as('lm'),
      (j) => j.onTrue(),
    )
    .select([
      'c.id',
      'c.created_at',
      'u.id as peer_id',
      'u.display_name as peer_name',
      'u.last_seen_at as peer_last_seen',
      'pm.last_delivered_message_id as peer_delivered',
      'pm.last_read_message_id as peer_read',
      unreadCount,
      'lm.id as m_id',
      'lm.sender_id as m_sender_id',
      'lm.client_id as m_client_id',
      'lm.body as m_body',
      'lm.created_at as m_created_at',
      'lm.edited_at as m_edited_at',
      'lm.deleted_at as m_deleted_at',
    ])
    .where('me.user_id', '=', userId)
    .where('c.type', '=', 'direct');
  if (conversationId) query = query.where('c.id', '=', conversationId);
  return query.orderBy(sql`coalesce(lm.created_at, c.created_at)`, 'desc').execute();
};

/** One page of history. `after` reads ascending (gap fill), otherwise descending from `before`. */
export const messagePage = (
  conversationId: string,
  limit: number,
  cursor: { before?: string; after?: string },
) => {
  let query = db
    .selectFrom('messages')
    .select(messageColumns)
    .where('conversation_id', '=', conversationId);
  if (cursor.after) query = query.where('id', '>', cursor.after);
  if (cursor.before) query = query.where('id', '<', cursor.before);
  return query
    .orderBy('id', cursor.after ? 'asc' : 'desc')
    .limit(limit)
    .execute();
};

/** Group conversation rows for one user, with the caller's role, member count and newest message. */
export const groupSummaries = (userId: string, conversationId?: string) => {
  let query = db
    .selectFrom('memberships as me')
    .innerJoin('conversations as c', 'c.id', 'me.conversation_id')
    .leftJoinLateral(
      (eb) =>
        eb
          .selectFrom('messages as m')
          .select(messageColumns)
          .whereRef('m.conversation_id', '=', 'c.id')
          .orderBy('m.id', 'desc')
          .limit(1)
          .as('lm'),
      (j) => j.onTrue(),
    )
    .select((eb) => [
      'c.id',
      'c.created_at',
      'c.name',
      'c.avatar_url',
      'me.role',
      eb
        .selectFrom('memberships as mc')
        .select(eb.fn.countAll<string>().as('n'))
        .whereRef('mc.conversation_id', '=', 'c.id')
        .as('member_count'),
      unreadCount,
      'lm.id as m_id',
      'lm.sender_id as m_sender_id',
      'lm.client_id as m_client_id',
      'lm.body as m_body',
      'lm.created_at as m_created_at',
      'lm.edited_at as m_edited_at',
      'lm.deleted_at as m_deleted_at',
    ])
    .where('me.user_id', '=', userId)
    .where('c.type', '=', 'group');
  if (conversationId) query = query.where('c.id', '=', conversationId);
  return query.execute();
};

export const findMessage = (id: string) =>
  db.selectFrom('messages').select(messageColumns).where('id', '=', id).executeTakeFirst();

// The guards repeat the service checks, so a concurrent delete or a closing window still wins.
export const editMessage = (id: string, senderId: string, body: string) =>
  db
    .updateTable('messages')
    .set({ body, edited_at: sql`now()` })
    .where('id', '=', id)
    .where('sender_id', '=', senderId)
    .where('deleted_at', 'is', null)
    .returning(messageColumns)
    .executeTakeFirst();

/** Tombstones the message and drops its reactions. The 10 minute window uses the DB clock. */
export const deleteMessage = (id: string, senderId: string) =>
  db.transaction().execute(async (trx) => {
    const row = await trx
      .updateTable('messages')
      .set({ body: null, deleted_at: sql`now()` })
      .where('id', '=', id)
      .where('sender_id', '=', senderId)
      .where('deleted_at', 'is', null)
      .where('created_at', '>', sql<Date>`now() - interval '10 minutes'`)
      .returning(messageColumns)
      .executeTakeFirst();
    if (row) {
      await trx.deleteFrom('reactions').where('message_id', '=', id).execute();
      await trx.deleteFrom('attachments').where('message_id', '=', id).execute();
    }
    return row;
  });

/** True when a row changed. Adding goes through a SELECT so a deleted message takes none. */
export const setReaction = async (messageId: string, userId: string, emoji: string, on: boolean) =>
  on
    ? ((
        await db
          .insertInto('reactions')
          .columns(['message_id', 'user_id', 'emoji'])
          .expression((eb) =>
            eb
              .selectFrom('messages')
              .select(['id', eb.val(userId).as('user_id'), eb.val(emoji).as('emoji')])
              .where('id', '=', messageId)
              .where('deleted_at', 'is', null),
          )
          .onConflict((oc) => oc.doNothing())
          .executeTakeFirst()
      ).numInsertedOrUpdatedRows ?? 0n) > 0n
    : (
        await db
          .deleteFrom('reactions')
          .where('message_id', '=', messageId)
          .where('user_id', '=', userId)
          .where('emoji', '=', emoji)
          .executeTakeFirst()
      ).numDeletedRows > 0n;

/** Reactions for a set of messages, one row per message and emoji. */
export const reactionsFor = (messageIds: readonly string[]) =>
  messageIds.length === 0
    ? Promise.resolve([])
    : db
        .selectFrom('reactions')
        .select([
          'message_id',
          'emoji',
          // text, not uuid: pg parses text[] into a JS array without extra type setup.
          sql<string[]>`array_agg(user_id::text ORDER BY created_at)`.as('user_ids'),
        ])
        .where('message_id', 'in', messageIds)
        .groupBy(['message_id', 'emoji'])
        .orderBy(sql`min(created_at)`)
        .execute();

/** File details (never the bytes) for a set of messages. */
export const attachmentsFor = (messageIds: readonly string[]) =>
  messageIds.length === 0
    ? Promise.resolve([])
    : db
        .selectFrom('attachments')
        .select(['id', 'message_id', 'name', 'mime', 'size'])
        .where('message_id', 'in', messageIds)
        .execute();
