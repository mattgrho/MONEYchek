import fs from 'node:fs';

// Development convenience: load .env when present (real environments inject
// variables directly; existing variables win).
try {
  if (fs.existsSync('.env') && process.env.NODE_ENV !== 'production') {
    process.loadEnvFile('.env');
  }
} catch {
  // no .env file: fine
}

const { getEnv } = await import('./config/env');
const { createApp } = await import('./app');
const { logger } = await import('./lib/logger');
const { closeDb } = await import('./db/client');

const env = getEnv();
const app = await createApp();

const server = app.listen(env.PORT, '0.0.0.0', () => {
  logger.info({ port: env.PORT, mode: env.NODE_ENV }, 'server listening');
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  const deadline = setTimeout(() => process.exit(1), 10_000);
  deadline.unref();
  server.close(async () => {
    await closeDb().catch(() => {});
    process.exit(0);
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
