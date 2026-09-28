import pg from 'pg';

/** Creates the test database if it is missing. Migrations run from the tests, via the app code. */
export default async function setup() {
  const url = new URL(
    process.env.TEST_DATABASE_URL ?? 'postgres://chat:chat@localhost:5432/chat_test',
  );
  const name = url.pathname.slice(1);
  const admin = new pg.Client({ connectionString: new URL('/postgres', url).toString() });
  await admin.connect();
  const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  if (!rowCount) await admin.query(`CREATE DATABASE "${name.replaceAll('"', '')}"`);
  await admin.end();
}
