import type { Migration } from 'kysely/migration';
import { init } from './0001_init.js';

// Register each migration here, keyed so names sort in apply order (e.g. '0001_init').
// A static map instead of FileMigrationProvider: it compiles into dist with the rest
// and avoids dynamic import() of absolute Windows paths in dev.
export const migrations: Record<string, Migration> = { '0001_init': init };
