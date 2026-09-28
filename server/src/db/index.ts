import { Kysely, PostgresDialect, type ColumnType, type Generated } from 'kysely';
import { Migrator } from 'kysely/migration';
import pg from 'pg';
import { config } from '../config.js';
import { migrations } from './migrations/index.js';

// Table interfaces are added here alongside each migration (keep both in the same commit).
// int8 columns come back from pg as strings, so message ids stay strings end to end (spec 0002).
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
type MessageId = ColumnType<string, never, never>;
type MessageRef = ColumnType<string | null, string | null | undefined, string | null>;

export type Role = 'owner' | 'admin' | 'member';

export interface UsersTable {
  id: Generated<string>;
  email: string;
  password_hash: string;
  display_name: string;
  last_seen_at: NullableTimestamp;
  created_at: Timestamp;
}

export interface RefreshTokensTable {
  id: Generated<string>;
  user_id: string;
  session_id: string;
  token_hash: string;
  expires_at: ColumnType<Date, Date | string, Date | string>;
  revoked_at: NullableTimestamp;
  replaced_by: string | null;
  created_at: Timestamp;
}

export interface ConversationsTable {
  id: Generated<string>;
  type: 'direct' | 'group';
  direct_key: string | null;
  name: string | null;
  avatar_url: string | null;
  created_by: string;
  created_at: Timestamp;
}

export interface MembershipsTable {
  conversation_id: string;
  user_id: string;
  role: Generated<Role>;
  last_delivered_message_id: MessageRef;
  last_read_message_id: MessageRef;
  joined_at: Timestamp;
}

export interface MessagesTable {
  id: MessageId; // GENERATED ALWAYS: never inserted or updated
  conversation_id: string;
  sender_id: string;
  client_id: string;
  body: string | null;
  created_at: Timestamp;
  edited_at: NullableTimestamp;
  deleted_at: NullableTimestamp;
}

export interface ReactionsTable {
  message_id: string;
  user_id: string;
  emoji: string;
  created_at: Timestamp;
}

export interface Database {
  users: UsersTable;
  refresh_tokens: RefreshTokensTable;
  conversations: ConversationsTable;
  memberships: MembershipsTable;
  messages: MessagesTable;
  reactions: ReactionsTable;
}

export const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: config.DATABASE_URL }) }),
});

export async function migrateToLatest(): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(migrations) },
  });
  const { error, results } = await migrator.migrateToLatest();
  for (const r of results ?? []) {
    if (r.status === 'Error') console.error(`migration failed: ${r.migrationName}`);
  }
  if (error) throw new Error('migration failed', { cause: error });
}
