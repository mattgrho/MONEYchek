import { and, eq, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client';
import { outboxEvents } from '../db/schema/index';
import { getEmailAdapter } from '../email/adapter';
import { logger } from '../lib/logger';

/**
 * Transactional outbox: rows are enqueued inside the same transaction as
 * the domain change, then drained by the job runner (a Replit Scheduled
 * Deployment runs `npm run jobs:run -- --once`; never in-process cron on
 * Autoscale). Claiming uses FOR UPDATE SKIP LOCKED so overlapping runs
 * never double-send; failures back off exponentially until maxAttempts,
 * then the row parks as 'dead' with the error kept for operators.
 */

export async function enqueueOutboxEvent(
  tx: DbOrTx,
  input: {
    organizationId: string;
    jobType: string;
    payload: Record<string, unknown>;
    idempotencyKey?: string;
  },
): Promise<void> {
  await tx.insert(outboxEvents).values({
    organizationId: input.organizationId,
    jobType: input.jobType,
    payload: input.payload,
    idempotencyKey: input.idempotencyKey ?? null,
  });
}

interface EmailPayload {
  to?: string;
  subject?: string;
  text?: string;
}

function backoffMinutes(attempts: number): number {
  return Math.min(2 ** attempts, 120);
}

export interface DrainResult {
  claimed: number;
  sent: number;
  failed: number;
  skippedNoProvider: boolean;
}

/**
 * Processes due email outbox events. When no provider is configured the
 * events are left untouched (pending) — nothing is marked sent, failed, or
 * dead just because the deployment has not connected email yet.
 */
export async function drainEmailOutbox(
  db: Db,
  options?: { limit?: number; leaseOwner?: string },
): Promise<DrainResult> {
  const adapter = getEmailAdapter();
  if (!adapter.available) {
    const [row] = await db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(outboxEvents)
      .where(and(eq(outboxEvents.state, 'pending'), sql`job_type LIKE 'email.%'`));
    if ((row?.n ?? 0) > 0) {
      logger.info(
        { pending: row!.n },
        'email outbox has pending events but no EMAIL_PROVIDER is configured; leaving them queued',
      );
    }
    return { claimed: 0, sent: 0, failed: 0, skippedNoProvider: true };
  }

  const limit = options?.limit ?? 50;
  const leaseOwner = options?.leaseOwner ?? `jobs-${process.pid}`;
  let sent = 0;
  let failed = 0;

  // Claim a batch atomically; overlapping runners skip locked rows.
  const claimedRows = await db.execute(sql`
    UPDATE outbox_events SET
      state = 'processing',
      lease_owner = ${leaseOwner},
      lease_expires_at = now() + interval '5 minutes',
      attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM outbox_events
      WHERE job_type LIKE 'email.%'
        AND (
          state = 'pending'
          OR (state = 'processing' AND lease_expires_at < now())
        )
        AND scheduled_at <= now()
      ORDER BY scheduled_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, job_type, payload, attempts, max_attempts
  `);

  interface Claimed {
    id: string;
    job_type: string;
    payload: EmailPayload;
    attempts: number;
    max_attempts: number;
  }
  const claimed = claimedRows.rows as unknown as Claimed[];

  for (const event of claimed) {
    const payload = event.payload ?? {};
    try {
      if (!payload.to || !payload.subject || !payload.text) {
        throw new Error('email payload needs to, subject, and text');
      }
      const { providerMessageId } = await getEmailAdapter().send({
        to: payload.to,
        subject: payload.subject,
        text: payload.text,
      });
      // Scrub the body after delivery: invitation emails carry a live
      // accept link (the invitations table itself stores only token
      // hashes), so the queued copy must not outlive its purpose.
      await db
        .update(outboxEvents)
        .set({
          state: 'completed',
          completedAt: new Date(),
          lastError: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          payload: {
            to: payload.to,
            subject: payload.subject,
            text: '[delivered; body not retained]',
            providerMessageId,
          },
        })
        .where(eq(outboxEvents.id, event.id));
      sent++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const dead = event.attempts >= event.max_attempts;
      await db
        .update(outboxEvents)
        .set({
          state: dead ? 'dead' : 'pending',
          lastError: message.slice(0, 1000),
          leaseOwner: null,
          leaseExpiresAt: null,
          scheduledAt: dead
            ? undefined
            : new Date(Date.now() + backoffMinutes(event.attempts) * 60_000),
        })
        .where(eq(outboxEvents.id, event.id));
      failed++;
      logger.warn({ eventId: event.id, err: message, dead }, 'email outbox delivery failed');
    }
  }
  return { claimed: claimed.length, sent, failed, skippedNoProvider: false };
}
