import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema/index';
import { getEnv, runtimeDatabaseUrl } from '../config/env';

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Either the root database handle or an open transaction. */
export type DbOrTx = Db | Tx;

let pool: pg.Pool | null = null;
let db: Db | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const env = getEnv();
    pool = new pg.Pool({
      connectionString: runtimeDatabaseUrl(env),
      // Conservative sizing for multiple Autoscale instances sharing one
      // managed PostgreSQL database.
      max: env.NODE_ENV === 'production' ? 8 : 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return pool;
}

export function getDb(): Db {
  if (!db) {
    db = drizzle(getPool(), { schema });
  }
  return db;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}

export { schema };
