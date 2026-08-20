import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { postingCommands } from '../db/schema/index';
import { AppError } from '../lib/errors';
import { canonicalJson } from './audit';

/**
 * Idempotent financial commands.
 *
 * Each command carries an organization-scoped idempotency key. The command
 * record is inserted, the work runs, and the result is stored — all in ONE
 * database transaction, so a command can never half-apply. Retrying with the
 * same key + same canonical payload returns the stored result; the same key
 * with a different payload returns 409 IDEMPOTENCY_CONFLICT.
 *
 * A concurrent duplicate blocks on the unique index until the first
 * transaction commits, then reads the winner's result.
 */
export async function runFinancialCommand<T>(
  db: Db,
  meta: {
    organizationId: string;
    idempotencyKey: string;
    commandType: string;
    payload: unknown;
    actorUserId?: string | null;
  },
  work: (tx: Tx) => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  if (!meta.idempotencyKey || meta.idempotencyKey.length > 200) {
    throw AppError.validation('Invalid idempotency key');
  }
  const requestHash = createHash('sha256').update(canonicalJson(meta.payload)).digest('hex');

  const existing = await db
    .select()
    .from(postingCommands)
    .where(
      and(
        eq(postingCommands.organizationId, meta.organizationId),
        eq(postingCommands.idempotencyKey, meta.idempotencyKey),
      ),
    )
    .limit(1);
  if (existing[0]) return replay<T>(existing[0], requestHash);

  try {
    const result = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(postingCommands)
        .values({
          organizationId: meta.organizationId,
          idempotencyKey: meta.idempotencyKey,
          commandType: meta.commandType,
          requestHash,
          state: 'processing',
          actorUserId: meta.actorUserId ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: postingCommands.id });
      if (!inserted[0]) {
        // Another transaction owns (or owned) this key.
        throw new ReplayNeeded();
      }
      const value = await work(tx);
      await tx
        .update(postingCommands)
        .set({
          state: 'completed',
          result: value === undefined ? null : (JSON.parse(JSON.stringify(value)) as unknown),
          completedAt: new Date(),
        })
        .where(eq(postingCommands.id, inserted[0].id));
      return value;
    });
    return { result, replayed: false };
  } catch (err) {
    if (err instanceof ReplayNeeded) {
      const winner = await db
        .select()
        .from(postingCommands)
        .where(
          and(
            eq(postingCommands.organizationId, meta.organizationId),
            eq(postingCommands.idempotencyKey, meta.idempotencyKey),
          ),
        )
        .limit(1);
      if (!winner[0]) throw AppError.conflict('IDEMPOTENCY_RACE', 'Retry the request');
      return replay<T>(winner[0], requestHash);
    }
    throw err;
  }
}

class ReplayNeeded extends Error {}

function replay<T>(
  record: typeof postingCommands.$inferSelect,
  requestHash: string,
): { result: T; replayed: boolean } {
  if (record.requestHash !== requestHash) {
    throw AppError.conflict(
      'IDEMPOTENCY_CONFLICT',
      'This idempotency key was already used with a different request payload',
    );
  }
  if (record.state === 'processing') {
    throw AppError.conflict(
      'COMMAND_IN_PROGRESS',
      'The same command is still being processed; retry shortly',
    );
  }
  if (record.state === 'failed') {
    throw AppError.conflict('COMMAND_FAILED', 'The original command failed; use a new key');
  }
  return { result: record.result as T, replayed: true };
}
