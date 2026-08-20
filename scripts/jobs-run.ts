/**
 * Background job runner (`npm run jobs:run -- --once`).
 *
 * Designed for a Replit Scheduled Deployment (never in-process cron on
 * Autoscale): each invocation drains due outbox work and exits. Without
 * --once it loops with a fixed interval, which is only appropriate for a
 * Reserved VM or local development.
 *
 * Today the outbox carries email jobs (invitation delivery). When no
 * EMAIL_PROVIDER is configured the runner reports the queue size and leaves
 * every event pending — nothing is ever marked sent without a provider
 * accepting it.
 */
import fs from 'node:fs';

try {
  if (fs.existsSync('.env')) process.loadEnvFile('.env');
} catch {
  /* no .env */
}

const LOOP_INTERVAL_MS = 60_000;

async function runOnce(): Promise<void> {
  const { getDb } = await import('../server/db/client');
  const { drainEmailOutbox } = await import('../server/services/outbox');
  const result = await drainEmailOutbox(getDb(), { leaseOwner: `jobs-${process.pid}` });
  if (result.skippedNoProvider) {
    console.log('email: no provider configured; pending events left queued');
  } else {
    console.log(`email: claimed ${result.claimed}, sent ${result.sent}, failed ${result.failed}`);
  }
}

async function main(): Promise<void> {
  const once = process.argv.includes('--once');
  if (once) {
    await runOnce();
    const { closeDb } = await import('../server/db/client');
    await closeDb();
    return;
  }
  console.log(`jobs runner looping every ${LOOP_INTERVAL_MS / 1000}s (Ctrl-C to stop)`);
  for (;;) {
    try {
      await runOnce();
    } catch (err) {
      console.error('job run failed:', err instanceof Error ? err.message : err);
    }
    await new Promise((resolve) => setTimeout(resolve, LOOP_INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
