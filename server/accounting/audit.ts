import { createHash } from 'node:crypto';
import { desc, eq, sql } from 'drizzle-orm';
import { auditEvents } from '../db/schema/index';
import type { Tx } from '../db/client';

/**
 * Immutable audit chain.
 *
 * Every financial or security-relevant action appends one audit_events row.
 * Rows form an organization-scoped hash chain: seq is monotonic, hash covers
 * a versioned canonical JSON serialization including prev_hash. Appends are
 * serialized with a per-organization advisory transaction lock, so two
 * concurrent transactions cannot fork the chain.
 *
 * A chain stored in the same database is an internal corruption/tamper
 * INDICATOR, not proof against a database administrator (documented in
 * README).
 */

export const AUDIT_CHAIN_VERSION = 1;
const GENESIS_HASH = 'GENESIS';

/** Deterministic JSON: object keys sorted recursively, arrays in order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortValue(v)]));
  }
  return value;
}

export interface AuditEventInput {
  organizationId: string;
  actorUserId?: string | null;
  actorRole?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  reason?: string | null;
  payload?: Record<string, unknown>;
  correlationId?: string | null;
}

export function computeAuditHash(input: {
  organizationId: string;
  seq: number;
  action: string;
  entityType: string;
  entityId: string | null;
  actorUserId: string | null;
  actorRole: string | null;
  reason: string | null;
  payload: Record<string, unknown>;
  correlationId: string | null;
  prevHash: string;
}): string {
  const canonical = canonicalJson({ v: AUDIT_CHAIN_VERSION, ...input });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Serializes audit appends (and posting) per organization. */
export async function acquireOrgLock(tx: Tx, organizationId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`);
}

/**
 * Appends an audit event inside the caller's transaction. Callers that write
 * financial data MUST use the same transaction so the audit trail can never
 * disagree with the books.
 */
export async function writeAuditEvent(
  tx: Tx,
  input: AuditEventInput,
): Promise<{ seq: number; hash: string }> {
  await acquireOrgLock(tx, input.organizationId);
  const last = await tx
    .select({ seq: auditEvents.seq, hash: auditEvents.hash })
    .from(auditEvents)
    .where(eq(auditEvents.organizationId, input.organizationId))
    .orderBy(desc(auditEvents.seq))
    .limit(1);

  const prev = last[0];
  const seq = prev ? prev.seq + 1 : 0;
  const prevHash = prev ? prev.hash : GENESIS_HASH;
  const record = {
    organizationId: input.organizationId,
    seq,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    actorUserId: input.actorUserId ?? null,
    actorRole: input.actorRole ?? null,
    reason: input.reason ?? null,
    payload: input.payload ?? {},
    correlationId: input.correlationId ?? null,
    prevHash,
  };
  const hash = computeAuditHash(record);
  await tx.insert(auditEvents).values({ ...record, hash });
  return { seq, hash };
}

/**
 * Verifies the whole chain for an organization. Returns the first broken
 * sequence number, or null when the chain is intact.
 */
export async function verifyAuditChain(
  db: Tx | import('../db/client').Db,
  organizationId: string,
): Promise<{ ok: boolean; brokenAtSeq: number | null; length: number }> {
  const rows = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.organizationId, organizationId))
    .orderBy(auditEvents.seq);
  let prevHash = GENESIS_HASH;
  for (const [i, row] of rows.entries()) {
    if (row.seq !== i) return { ok: false, brokenAtSeq: row.seq, length: rows.length };
    const expected = computeAuditHash({
      organizationId: row.organizationId,
      seq: row.seq,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      actorUserId: row.actorUserId,
      actorRole: row.actorRole,
      reason: row.reason,
      payload: (row.payload ?? {}) as Record<string, unknown>,
      correlationId: row.correlationId,
      prevHash,
    });
    if (expected !== row.hash) return { ok: false, brokenAtSeq: row.seq, length: rows.length };
    prevHash = row.hash;
  }
  return { ok: true, brokenAtSeq: null, length: rows.length };
}
