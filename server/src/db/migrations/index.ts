import type { Migration } from 'kysely/migration';

// Register each migration here, keyed so names sort in apply order (e.g. '0001_init').
// A static map instead of FileMigrationProvider: it compiles into dist with the rest
// and avoids dynamic import() of absolute Windows paths in dev.
export const migrations: Record<string, Migration> = {};
