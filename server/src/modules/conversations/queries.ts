import { sql } from 'kysely';
import { db } from '../../db/index.js';

const messageColumns = [
  'id',
  'conversation_id',
  'sender_id',
  'client_id',
  'body',
  'created_at',
] as const;

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
export const insertMessage = async (
  senderId: string,
  conversationId: string,
  clientId: string,
  body: string,
) => {
  const inserted = await db
    .insertInto('messages')
    .values({ conversation_id: conversationId, sender_id: senderId, client_id: clientId, body })
    .onConflict((oc) => oc.columns(['sender_id', 'client_id']).doNothing())
    .returning(messageColumns)
    .executeTakeFirst();
  if (inserted) return { row: inserted, created: true };
  const row = await db
    .selectFrom('messages')
    .select(messageColumns)
    .where('sender_id', '=', senderId)
    .where('client_id', '=', clientId)
    .executeTakeFirstOrThrow();
  return { row, created: false };
};

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
      'lm.id as m_id',
      'lm.sender_id as m_sender_id',
      'lm.client_id as m_client_id',
      'lm.body as m_body',
      'lm.created_at as m_created_at',
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
      'lm.id as m_id',
      'lm.sender_id as m_sender_id',
      'lm.client_id as m_client_id',
      'lm.body as m_body',
      'lm.created_at as m_created_at',
    ])
    .where('me.user_id', '=', userId)
    .where('c.type', '=', 'group');
  if (conversationId) query = query.where('c.id', '=', conversationId);
  return query.execute();
};
