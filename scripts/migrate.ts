/**
 * Migration runner. Applies committed SQL migrations from db/migrations in
 * filename order inside a PostgreSQL advisory lock, recording each in a
 * migration ledger table. Never runs automatically on web startup: this is an
 * explicit, human-triggered release step (`npm run db:migrate`).
 *
 * Connection resolution:
 *   - MIGRATION_DATABASE_URL when set (production release step)
 *   - otherwise DATABASE_URL (development)
 *   - `--test` flag: TEST_DATABASE_URL, with guards against production targets
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../db/migrations',
);
const ADVISORY_LOCK_KEY = 727_001_001;

export async function runMigrations(connectionString: string): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    const lock = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [ADVISORY_LOCK_KEY]);
    if (!lock.rows[0]?.ok) {
      throw new Error('Another migration is in progress (advisory lock busy).');
    }
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const done = new Set(
      (await client.query('SELECT filename FROM schema_migrations')).rows.map(
        (r: { filename: string }) => r.filename,
      ),
    );
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {});
    await client.end();
  }
}

function isTestSafeUrl(url: string): boolean {
  return /test/i.test(url);
}

async function main() {
  const isTest = process.argv.includes('--test');
  let url: string | undefined;
  if (isTest) {
    url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('TEST_DATABASE_URL is not set');
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Refusing to run test migrations with NODE_ENV=production');
    }
    if (url === process.env.DATABASE_URL || url === process.env.MIGRATION_DATABASE_URL) {
      throw new Error('TEST_DATABASE_URL must not equal DATABASE_URL/MIGRATION_DATABASE_URL');
    }
    if (!isTestSafeUrl(url)) {
      throw new Error('TEST_DATABASE_URL must reference an explicitly test-named database');
    }
  } else {
    url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!url) throw new Error('Set MIGRATION_DATABASE_URL (or DATABASE_URL in development)');
  }
  const applied = await runMigrations(url);
  if (applied.length === 0) {
    console.log('Database is up to date; no migrations applied.');
  } else {
    for (const f of applied) console.log(`applied ${f}`);
  }
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
