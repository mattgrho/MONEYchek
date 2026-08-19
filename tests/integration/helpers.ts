/**
 * Integration test harness. Loads the real Express app with the test-only
 * auth adapter (NODE_ENV=test) against the isolated TEST_DATABASE_URL that
 * tests/global-setup.ts freshly migrated.
 */
process.env.NODE_ENV = 'test';
process.env.BOOTSTRAP_OWNER_EMAIL ??= 'owner@example.test';
process.env.APP_BASE_URL ??= 'http://localhost:5000';

import type { Express } from 'express';

export interface TestIdentity {
  authProviderId: string;
  email: string;
  emailVerified?: boolean;
  name?: string;
}

export function identity(email: string, name?: string): TestIdentity {
  return { authProviderId: `test|${email}`, email, name: name ?? email.split('@')[0] };
}

export function authHeader(id: TestIdentity): string {
  return JSON.stringify(id);
}

let appPromise: Promise<Express> | null = null;

export async function getApp(): Promise<Express> {
  if (!appPromise) {
    appPromise = (async () => {
      if (!process.env.TEST_DATABASE_URL) {
        throw new Error('TEST_DATABASE_URL is required for integration tests (see .env.example)');
      }
      const { createApp } = await import('@server/app');
      return createApp();
    })();
  }
  return appPromise;
}

/** Truncates all business tables (never the migration ledger). */
export async function resetDatabase(): Promise<void> {
  const { getPool } = await import('@server/db/client');
  const pool = getPool();
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );
  if (rows.length === 0) return;
  const tables = rows.map((r) => `"${r.tablename}"`).join(', ');
  await pool.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
}

export const OWNER = identity('owner@example.test', 'Olive Owner');

/** Bootstraps the deployment as OWNER and returns the organization id. */
export async function bootstrapCompany(
  app: Express,
  companyName = 'Test Company',
): Promise<string> {
  const request = (await import('supertest')).default;
  const res = await request(app)
    .post('/api/v1/bootstrap')
    .set('x-test-auth', authHeader(OWNER))
    .send({ companyName });
  if (res.status !== 201) {
    throw new Error(`bootstrap failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.organizationId as string;
}
