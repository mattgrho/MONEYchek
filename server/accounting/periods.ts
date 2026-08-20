import { and, eq, gte, lte, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { fiscalPeriods } from '../db/schema/index';
import { AppError } from '../lib/errors';

/**
 * Fiscal periods are calendar months, created lazily as OPEN when a posting
 * needs one. Close state gates every posting:
 *   open         -> post normally
 *   soft_closed  -> only an explicit privileged override (reason required)
 *   hard_closed  -> rejected, always
 * Enforcement lives here in the posting path, not in UI code.
 */

function monthRange(dateISO: string): { start: string; end: string } {
  const [y, m] = dateISO.split('-');
  const year = Number.parseInt(y!, 10);
  const month = Number.parseInt(m!, 10);
  const start = `${y}-${m}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const end = `${y}-${m}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
}

export async function getOrCreatePeriod(
  tx: Tx,
  organizationId: string,
  postingDate: string,
): Promise<typeof fiscalPeriods.$inferSelect> {
  const existing = await tx
    .select()
    .from(fiscalPeriods)
    .where(
      and(
        eq(fiscalPeriods.organizationId, organizationId),
        lte(fiscalPeriods.startDate, postingDate),
        gte(fiscalPeriods.endDate, postingDate),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0];
  const { start, end } = monthRange(postingDate);
  const inserted = await tx
    .insert(fiscalPeriods)
    .values({ organizationId, startDate: start, endDate: end })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return inserted[0];
  const retry = await tx
    .select()
    .from(fiscalPeriods)
    .where(
      and(eq(fiscalPeriods.organizationId, organizationId), eq(fiscalPeriods.startDate, start)),
    )
    .limit(1);
  if (!retry[0]) throw new Error('failed to create fiscal period');
  return retry[0];
}

export interface PeriodOverride {
  /** Soft-close override: requires periods.reopen permission and a reason. */
  allowSoftClosed?: boolean;
  reason?: string;
}

export async function assertPostingAllowed(
  tx: Tx,
  organizationId: string,
  postingDate: string,
  override?: PeriodOverride,
): Promise<void> {
  const existing = await tx
    .select()
    .from(fiscalPeriods)
    .where(
      and(
        eq(fiscalPeriods.organizationId, organizationId),
        lte(fiscalPeriods.startDate, postingDate),
        gte(fiscalPeriods.endDate, postingDate),
      ),
    )
    .limit(1);
  const period = existing[0];

  if (period) {
    if (period.status === 'hard_closed') {
      throw AppError.unprocessable(
        'PERIOD_HARD_CLOSED',
        `The period ${period.startDate} – ${period.endDate} is closed; no financial change is allowed until it is reopened`,
      );
    }
    if (period.status === 'soft_closed') {
      if (!override?.allowSoftClosed || !override.reason) {
        throw AppError.unprocessable(
          'PERIOD_SOFT_CLOSED',
          `The period ${period.startDate} – ${period.endDate} is soft-closed; posting requires a privileged override with a reason`,
        );
      }
    }
    // An explicitly reopened (open) period is postable even behind the close
    // boundary — that is exactly what a privileged reopen means.
    return;
  }

  // No period row exists for this month. A close-through boundary still
  // applies: months at or before the boundary are closed even if their rows
  // were never materialized.
  const hardEnd = await latestClosedEndDate(tx, organizationId, 'hard_closed');
  if (hardEnd && postingDate <= hardEnd) {
    throw AppError.unprocessable(
      'PERIOD_HARD_CLOSED',
      `Postings on or before ${hardEnd} are hard-closed`,
    );
  }
  const softEnd = await latestClosedEndDate(tx, organizationId, 'soft_closed');
  if (softEnd && postingDate <= softEnd && (!override?.allowSoftClosed || !override.reason)) {
    throw AppError.unprocessable(
      'PERIOD_SOFT_CLOSED',
      `Postings on or before ${softEnd} require a privileged override with a reason`,
    );
  }
  await getOrCreatePeriod(tx, organizationId, postingDate);
}

/** Closes every period whose end date is on or before the given date. */
export async function closePeriodsThrough(
  tx: Tx,
  organizationId: string,
  throughDate: string,
  mode: 'soft_closed' | 'hard_closed',
  actorUserId: string,
): Promise<number> {
  // Materialize periods for every month up to throughDate that has activity
  // is unnecessary: closing only affects existing periods plus the month of
  // throughDate itself, and postings into never-created months earlier than
  // throughDate must still be blocked. We keep a simple rule: create the
  // period containing throughDate, then close all periods ending on/before.
  await getOrCreatePeriod(tx, organizationId, throughDate);
  const result = await tx
    .update(fiscalPeriods)
    .set({ status: mode, closedByUserId: actorUserId, closedAt: sql`now()` })
    .where(
      and(
        eq(fiscalPeriods.organizationId, organizationId),
        lte(fiscalPeriods.endDate, monthRange(throughDate).end),
        sql`${fiscalPeriods.status} <> 'hard_closed'`,
      ),
    )
    .returning({ id: fiscalPeriods.id });
  return result.length;
}

/**
 * The earliest-closed rule: a posting date in any month at or before a
 * closed period must also be blocked even if its period row never existed.
 */
export async function latestClosedEndDate(
  tx: Tx,
  organizationId: string,
  mode: 'soft_closed' | 'hard_closed',
): Promise<string | null> {
  const rows = await tx
    .select({ end: sql<string>`MAX(${fiscalPeriods.endDate})` })
    .from(fiscalPeriods)
    .where(and(eq(fiscalPeriods.organizationId, organizationId), eq(fiscalPeriods.status, mode)));
  return rows[0]?.end ?? null;
}

export async function reopenPeriod(
  tx: Tx,
  organizationId: string,
  periodId: string,
  actorUserId: string,
  reason: string,
): Promise<void> {
  const [period] = await tx
    .select()
    .from(fiscalPeriods)
    .where(and(eq(fiscalPeriods.id, periodId), eq(fiscalPeriods.organizationId, organizationId)))
    .for('update')
    .limit(1);
  if (!period) throw AppError.notFound('Period not found');
  if (period.status === 'open') return;
  await tx
    .update(fiscalPeriods)
    .set({
      status: 'open',
      reopenedByUserId: actorUserId,
      reopenedAt: sql`now()`,
      reopenReason: reason,
    })
    .where(eq(fiscalPeriods.id, periodId));
}
