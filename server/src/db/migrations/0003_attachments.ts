import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

// Files live in Postgres (bytea), so the app stays one container plus one database.
// An upload has no message_id until a send claims it; UNIQUE keeps it to one message, and the
// cascade removes the file with its conversation or its message.
export const attachments: Migration = {
  async up(db: Kysely<unknown>) {
    await sql`CREATE TABLE attachments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
      uploader_id uuid NOT NULL REFERENCES users (id),
      message_id bigint UNIQUE REFERENCES messages (id) ON DELETE CASCADE,
      name text NOT NULL,
      mime text NOT NULL,
      size integer NOT NULL CHECK (size BETWEEN 1 AND 5242880),
      data bytea NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  },
  async down(db: Kysely<unknown>) {
    await sql`DROP TABLE attachments`.execute(db);
  },
};
