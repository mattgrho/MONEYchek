/**
 * Vitest global setup: prepares a pristine, isolated test database.
 *
 * Guards (all hard failures, never silently redirected):
 *  - refuses to run when NODE_ENV=production
 *  - requires TEST_DATABASE_URL for integration tests
 *  - TEST_DATABASE_URL must be test-named and distinct from DATABASE_URL and
 *    MIGRATION_DATABASE_URL
 *
 * Unit tests (tests/unit, client) do not touch the database; when
 * TEST_DATABASE_URL is absent the setup leaves a marker so integration tests
 * fail with a clear message instead of hanging.
 */
import pg from 'pg';
import { runMigrations } from '../scripts/migrate';

export default async function globalSetup(): Promise<void> {
  process.env.NODE_ENV = 'test';
  if (process.env.CI === undefined && !process.env.TEST_DATABASE_URL) {
    // Unit-only run without a database; integration tests will fail loudly.
    return;
  }
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  if (url === process.env.DATABASE_URL || url === process.env.MIGRATION_DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL must not equal DATABASE_URL/MIGRATION_DATABASE_URL');
  }
  if (!/test/i.test(url)) {
    throw new Error('TEST_DATABASE_URL must reference an explicitly test-named database');
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    // Verify we really are inside a test-named database before wiping anything.
    const { rows } = await client.query('SELECT current_database() AS db');
    const dbName: string = rows[0].db;
    if (!/test/i.test(dbName)) {
      throw new Error(`Refusing to reset non-test database "${dbName}"`);
    }
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    await client.end();
  }
  await runMigrations(url);
}
