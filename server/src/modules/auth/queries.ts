import { sql } from 'kysely';
import { db } from '../../db/index.js';

// Explicit columns only: password_hash and token_hash never leave this file by accident.
const userColumns = ['id', 'email', 'display_name'] as const;

// Undefined when the email is taken: the users.email UNIQUE constraint decides, not a pre check.
export const insertUser = (email: string, passwordHash: string, displayName: string) =>
  db
    .insertInto('users')
    .values({ email, password_hash: passwordHash, display_name: displayName })
    .onConflict((oc) => oc.column('email').doNothing())
    .returning(userColumns)
    .executeTakeFirst();

export const findUserByEmail = (email: string) =>
  db
    .selectFrom('users')
    .select([...userColumns, 'password_hash'])
    .where('email', '=', email)
    .executeTakeFirst();

export const findUserById = (id: string) =>
  db.selectFrom('users').select(userColumns).where('id', '=', id).executeTakeFirst();

export const insertRefreshToken = (
  userId: string,
  sessionId: string,
  tokenHash: string,
  expiresAt: Date,
) =>
  db
    .insertInto('refresh_tokens')
    .values({
      user_id: userId,
      session_id: sessionId,
      token_hash: tokenHash,
      expires_at: expiresAt,
    })
    .execute();

// One transaction: claim the old row (the conditional UPDATE is the lock), insert the new row in
// the same session, then link the old row to it. Undefined means the token was not claimable.
export const rotateRefreshToken = (oldHash: string, newHash: string, expiresAt: Date) =>
  db.transaction().execute(async (trx) => {
    const old = await trx
      .updateTable('refresh_tokens')
      .set({ revoked_at: sql`now()` })
      .where('token_hash', '=', oldHash)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', sql<Date>`now()`)
      .returning(['id', 'user_id', 'session_id'])
      .executeTakeFirst();
    if (!old) return undefined;
    const fresh = await trx
      .insertInto('refresh_tokens')
      .values({
        user_id: old.user_id,
        session_id: old.session_id,
        token_hash: newHash,
        expires_at: expiresAt,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .updateTable('refresh_tokens')
      .set({ replaced_by: fresh.id })
      .where('id', '=', old.id)
      .execute();
    return { userId: old.user_id, sessionId: old.session_id };
  });

// The DB clock decides the grace window, so app and DB clock skew cannot widen it.
export const findRefreshToken = (tokenHash: string) =>
  db
    .selectFrom('refresh_tokens')
    .select([
      'user_id',
      'session_id',
      'replaced_by',
      sql<boolean>`coalesce(revoked_at > now() - interval '10 seconds', false)`.as('in_grace'),
    ])
    .where('token_hash', '=', tokenHash)
    .executeTakeFirst();

export const isSessionLive = async (sessionId: string) => {
  const row = await db
    .selectFrom('refresh_tokens')
    .select('id')
    .where('session_id', '=', sessionId)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', sql<Date>`now()`)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
};

export const revokeSession = (sessionId: string) =>
  db
    .updateTable('refresh_tokens')
    .set({ revoked_at: sql`now()` })
    .where('session_id', '=', sessionId)
    .where('revoked_at', 'is', null)
    .execute();
