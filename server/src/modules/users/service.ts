import type { UserSummary } from '@chat/shared';
import * as q from './queries.js';

const SEARCH_LIMIT = 20;

/** Escapes LIKE wildcards so `%` and `_` in the query match literally (paired with ESCAPE '\'). */
export const likeContains = (text: string) => `%${text.replace(/[\\%_]/g, '\\$&')}%`;

export async function searchUsers(me: string, text: string): Promise<UserSummary[]> {
  const rows = await q.search(me, likeContains(text), SEARCH_LIMIT);
  return rows.map((r) => ({ id: r.id, displayName: r.display_name, email: r.email }));
}
