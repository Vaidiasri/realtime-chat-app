import { sql } from 'kysely';
import { db } from '../../db/index.js';

// `pattern` is already LIKE escaped with backslash. Explicit columns: password_hash never leaves.
export const search = (me: string, pattern: string, limit: number) =>
  db
    .selectFrom('users')
    .select(['id', 'display_name', 'email'])
    .where('id', '<>', me)
    .where((eb) =>
      eb.or([
        sql<boolean>`display_name ILIKE ${pattern} ESCAPE '\\'`,
        sql<boolean>`email ILIKE ${pattern} ESCAPE '\\'`,
      ]),
    )
    .orderBy('display_name')
    .limit(limit)
    .execute();
