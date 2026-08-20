import pg from 'pg';
import { runMigrations } from '../../scripts/migrate';

/** Fresh, isolated, explicitly test-named database for every E2E run. */
export default async function globalSetup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/ledgeros_test';
  if (!/test/i.test(url)) {
    throw new Error('TEST_DATABASE_URL must reference an explicitly test-named database');
  }
  if (url === process.env.DATABASE_URL || url === process.env.MIGRATION_DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL must not equal DATABASE_URL/MIGRATION_DATABASE_URL');
  }
  process.env.TEST_DATABASE_URL = url;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT current_database() AS db');
    if (!/test/i.test(rows[0].db))
      throw new Error(`Refusing to reset non-test database ${rows[0].db}`);
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    await client.end();
  }
  await runMigrations(url);
}
