import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

// A message that carries a file may have no caption, so an empty body is allowed. The send
// schema still requires a body or a file, so an empty message with neither never reaches here.
export const fileOnlyBody: Migration = {
  async up(db: Kysely<unknown>) {
    await sql`ALTER TABLE messages DROP CONSTRAINT messages_body_check,
      ADD CONSTRAINT messages_body_check CHECK (body IS NULL OR length(body) <= 4000)`.execute(db);
  },
  async down(db: Kysely<unknown>) {
    await sql`ALTER TABLE messages DROP CONSTRAINT messages_body_check,
      ADD CONSTRAINT messages_body_check CHECK (body IS NULL OR length(body) BETWEEN 1 AND 4000)`.execute(
      db,
    );
  },
};
