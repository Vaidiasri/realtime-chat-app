import { Kysely, PostgresDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import pg from 'pg';
import { config } from '../config.js';
import { migrations } from './migrations/index.js';

// Table interfaces are added here alongside each migration (keep both in the same commit).
export interface Database {}

export const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: config.DATABASE_URL }) }),
});

export async function migrateToLatest(): Promise<void> {
  const migrator = new Migrator({ db, provider: { getMigrations: async () => migrations } });
  const { error, results } = await migrator.migrateToLatest();
  for (const r of results ?? []) {
    if (r.status === 'Error') console.error(`migration failed: ${r.migrationName}`);
  }
  if (error) throw error;
}
