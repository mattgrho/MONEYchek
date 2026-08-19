import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './server/db/schema/index.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    // drizzle-kit is only used to GENERATE migrations from schema; it never
    // pushes to a database. Migration application goes through scripts/migrate.ts.
    url: process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/ledgeros_dev',
  },
  strict: true,
  verbose: true,
});
