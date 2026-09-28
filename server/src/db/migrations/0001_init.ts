import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

// Schema from spec 0002. Every rule Postgres can hold is a constraint here, not an app check.
const up = [
  sql`CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) <= 254),
    password_hash text NOT NULL,
    display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 100),
    last_seen_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  sql`CREATE TABLE refresh_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    replaced_by uuid REFERENCES refresh_tokens (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  sql`CREATE INDEX refresh_tokens_user_id_idx ON refresh_tokens (user_id)`,
  sql`CREATE TABLE conversations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    type text NOT NULL CHECK (type IN ('direct', 'group')),
    direct_key text UNIQUE,
    name text CHECK (length(btrim(name)) BETWEEN 1 AND 100),
    avatar_url text CHECK (length(avatar_url) <= 2048),
    created_by uuid NOT NULL REFERENCES users (id),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT conversations_shape_check CHECK (
      (type = 'direct' AND direct_key IS NOT NULL AND name IS NULL)
      OR (type = 'group' AND direct_key IS NULL AND name IS NOT NULL)
    )
  )`,
  sql`CREATE TABLE messages (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    sender_id uuid NOT NULL REFERENCES users (id),
    client_id uuid NOT NULL,
    body text CHECK (body IS NULL OR length(body) BETWEEN 1 AND 4000),
    created_at timestamptz NOT NULL DEFAULT now(),
    edited_at timestamptz,
    deleted_at timestamptz,
    CONSTRAINT messages_sender_client_key UNIQUE (sender_id, client_id),
    CONSTRAINT messages_deleted_body_check CHECK ((deleted_at IS NULL) = (body IS NOT NULL))
  )`,
  // Serves the history cursor, reconnect sync, latest message lateral and unread count.
  sql`CREATE INDEX messages_conversation_id_id_idx ON messages (conversation_id, id DESC)`,
  sql`CREATE TABLE memberships (
    conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users (id),
    role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
    last_delivered_message_id bigint REFERENCES messages (id) ON DELETE SET NULL,
    last_read_message_id bigint REFERENCES messages (id) ON DELETE SET NULL,
    joined_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, user_id)
  )`,
  sql`CREATE UNIQUE INDEX memberships_one_owner_idx ON memberships (conversation_id) WHERE role = 'owner'`,
  sql`CREATE INDEX memberships_user_id_idx ON memberships (user_id)`,
  sql`CREATE TABLE reactions (
    message_id bigint NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users (id),
    emoji text NOT NULL CHECK (length(emoji) BETWEEN 1 AND 16),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id, emoji)
  )`,
];

const down = ['reactions', 'memberships', 'messages', 'conversations', 'refresh_tokens', 'users'];

export const init: Migration = {
  async up(db: Kysely<unknown>) {
    for (const statement of up) await statement.execute(db);
  },
  async down(db: Kysely<unknown>) {
    for (const table of down) await sql`DROP TABLE ${sql.table(table)}`.execute(db);
  },
};
