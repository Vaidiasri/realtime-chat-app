import { sql } from 'kysely';
import { db } from '../../db/index.js';

export interface MarkRow {
  conversation_id: string;
  last_delivered_message_id: string | null;
  last_read_message_id: string | null;
}

/**
 * Moves the caller's own marks forward to the newest message at or below `messageId` in that
 * conversation. No membership row matches for a non member, so nothing changes. Returns the new
 * marks only when one of them moved. A read also raises delivered.
 */
export const mark = async (
  userId: string,
  conversationId: string,
  messageId: string,
  read: boolean,
) =>
  (
    await sql<MarkRow>`
      UPDATE memberships AS me
      SET last_delivered_message_id = GREATEST(coalesce(me.last_delivered_message_id, 0), t.id),
          last_read_message_id = CASE WHEN ${read}::boolean
            THEN GREATEST(coalesce(me.last_read_message_id, 0), t.id)
            ELSE me.last_read_message_id END
      FROM (SELECT max(id) AS id FROM messages
            WHERE conversation_id = ${conversationId} AND id <= ${messageId}::bigint) AS t
      WHERE me.conversation_id = ${conversationId} AND me.user_id = ${userId} AND t.id IS NOT NULL
        AND (t.id > coalesce(me.last_delivered_message_id, 0)
          OR (${read}::boolean AND t.id > coalesce(me.last_read_message_id, 0)))
      RETURNING me.conversation_id, me.last_delivered_message_id, me.last_read_message_id
    `.execute(db)
  ).rows[0];

/** Offline catch up: delivered moves to each conversation's newest message, in one statement. */
export const catchUpDelivered = async (userId: string) =>
  (
    await sql<MarkRow>`
      UPDATE memberships AS me
      SET last_delivered_message_id = t.id
      FROM (SELECT mm.conversation_id,
                   (SELECT max(m.id) FROM messages m WHERE m.conversation_id = mm.conversation_id) AS id
            FROM memberships mm WHERE mm.user_id = ${userId}) AS t
      WHERE me.user_id = ${userId} AND me.conversation_id = t.conversation_id
        AND t.id > coalesce(me.last_delivered_message_id, 0)
      RETURNING me.conversation_id, me.last_delivered_message_id, me.last_read_message_id
    `.execute(db)
  ).rows;
