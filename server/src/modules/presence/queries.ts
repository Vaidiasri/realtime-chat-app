import { db } from '../../db/index.js';

export const setLastSeen = (userId: string, at: Date) =>
  db.updateTable('users').set({ last_seen_at: at }).where('id', '=', userId).execute();

export const lastSeen = async (userId: string) =>
  (await db.selectFrom('users').select('last_seen_at').where('id', '=', userId).executeTakeFirst())
    ?.last_seen_at ?? null;
