import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool } from '../db/client';
import { getEnv } from '../config/env';
import { asyncHandler } from '../middleware/validate';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../db/migrations',
);

export const healthRouter = Router();

healthRouter.get('/health/live', (_req, res) => {
  res.json({ status: 'ok' });
});

healthRouter.get(
  '/health/ready',
  asyncHandler(async (_req, res) => {
    const checks: Record<string, string> = {};
    let ok = true;

    try {
      await Promise.race([
        getPool().query('SELECT 1'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
      ]);
      checks.database = 'ok';
    } catch (err) {
      checks.database = `unavailable: ${(err as Error).message}`;
      ok = false;
    }

    if (checks.database === 'ok') {
      try {
        const expected = fs
          .readdirSync(MIGRATIONS_DIR)
          .filter((f) => f.endsWith('.sql'))
          .sort();
        const { rows } = await getPool().query<{ filename: string }>(
          'SELECT filename FROM schema_migrations',
        );
        const applied = new Set(rows.map((r) => r.filename));
        const missing = expected.filter((f) => !applied.has(f));
        if (missing.length > 0) {
          checks.schema = `SCHEMA_VERSION_MISMATCH: pending ${missing.join(', ')}`;
          ok = false;
        } else {
          checks.schema = 'ok';
        }
      } catch {
        checks.schema = 'SCHEMA_VERSION_MISMATCH: schema_migrations missing';
        ok = false;
      }
    }

    const env = getEnv();
    checks.auth =
      env.NODE_ENV === 'test' || (env.CLERK_SECRET_KEY && env.CLERK_PUBLISHABLE_KEY)
        ? 'ok'
        : 'not_configured';
    if (env.NODE_ENV === 'production' && checks.auth !== 'ok') ok = false;

    res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'not_ready', checks });
  }),
);
