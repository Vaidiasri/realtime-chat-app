import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

// Spec 0003: every rotation of one login keeps its session_id, the JWT `sid`.
// No backfill: no refresh token exists before this feature.
export const refreshSession: Migration = {
  async up(db: Kysely<unknown>) {
    await sql`ALTER TABLE refresh_tokens ADD COLUMN session_id uuid NOT NULL`.execute(db);
    await sql`CREATE INDEX refresh_tokens_session_id_idx ON refresh_tokens (session_id)`.execute(
      db,
    );
  },
  async down(db: Kysely<unknown>) {
    await sql`DROP INDEX refresh_tokens_session_id_idx`.execute(db);
    await sql`ALTER TABLE refresh_tokens DROP COLUMN session_id`.execute(db);
  },
};
