import { db } from '../../db/index.js';

export const insertAttachment = (row: {
  conversation_id: string;
  uploader_id: string;
  name: string;
  mime: string;
  data: Buffer;
}) =>
  db
    .insertInto('attachments')
    .values({ ...row, size: row.data.length })
    .returning(['id', 'name', 'mime', 'size'])
    .executeTakeFirstOrThrow();

export const findAttachment = (id: string, conversationId: string) =>
  db
    .selectFrom('attachments')
    .select(['name', 'mime', 'data', 'uploader_id', 'message_id'])
    .where('id', '=', id)
    .where('conversation_id', '=', conversationId)
    .executeTakeFirst();
