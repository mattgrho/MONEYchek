import { sql } from 'drizzle-orm';
import { cmp, roundMoney } from '@shared/money';
import type { DbOrTx } from '../db/client';
import { trialBalance } from './financial';
import { arAging, arControlBalance } from './ar';
import { apAging, apControlBalance } from './ap';

/**
 * Pre-close tie-out checklist (spec: close checklist surfaced before
 * soft/hard close). Every check is computed from the ledger and source
 * documents at request time; nothing is cached. `fail` means the books do
 * not tie and closing should wait for investigation; `warning` means open
 * work is dated in the range being closed (allowed, but flagged).
 */

export interface CloseCheckItem {
  key: string;
  label: string;
  status: 'pass' | 'warning' | 'fail';
  detail: string;
  value?: string;
}

export interface CloseChecklistReport {
  throughDate: string;
  ready: boolean;
  items: CloseCheckItem[];
}

async function scalar(db: DbOrTx, query: ReturnType<typeof sql>): Promise<string> {
  const result = await db.execute(query);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  const first = row ? Object.values(row)[0] : null;
  return first === null || first === undefined ? '0' : String(first);
}

async function systemAccountBalance(
  db: DbOrTx,
  organizationId: string,
  systemKey: string,
  asOf?: string,
): Promise<string | null> {
  const result = await db.execute(sql`
    SELECT a.id,
           COALESCE((
             SELECT SUM(l.debit - l.credit)
             FROM journal_lines l
             JOIN journal_entries e ON e.id = l.entry_id
             WHERE l.account_id = a.id
               ${asOf ? sql`AND e.posting_date <= ${asOf}::date` : sql``}
           ), 0)::text AS balance
    FROM accounts a
    WHERE a.organization_id = ${organizationId} AND a.system_key = ${systemKey}
    LIMIT 1
  `);
  const row = result.rows[0] as { balance: string } | undefined;
  return row ? roundMoney(row.balance) : null;
}

export async function closeChecklist(
  db: DbOrTx,
  organizationId: string,
  throughDate: string,
): Promise<CloseChecklistReport> {
  const items: CloseCheckItem[] = [];

  // 1. Trial balance in balance (a failure here means ledger corruption —
  //    the DB trigger should make this impossible).
  const tb = await trialBalance(db, organizationId, throughDate);
  const tbOk = tb.totalDebits === tb.totalCredits;
  items.push({
    key: 'trial_balance',
    label: 'Trial balance is in balance',
    status: tbOk ? 'pass' : 'fail',
    detail: tbOk
      ? `Debits ${tb.totalDebits} = credits ${tb.totalCredits}`
      : `Debits ${tb.totalDebits} ≠ credits ${tb.totalCredits} — investigate before closing`,
  });

  // 2. AR aging ties to the AR control account.
  const ar = await arAging(db, organizationId, throughDate);
  const arControl = await arControlBalance(db, organizationId, throughDate);
  const arOk = ar.total === arControl;
  items.push({
    key: 'ar_tie_out',
    label: 'AR aging ties to Accounts Receivable',
    status: arOk ? 'pass' : 'fail',
    detail: arOk
      ? `Open items ${ar.total} = control ${arControl}`
      : `Open items ${ar.total} ≠ control ${arControl}`,
    value: arControl,
  });

  // 3. AP aging ties to the AP control account.
  const ap = await apAging(db, organizationId, throughDate);
  const apControl = await apControlBalance(db, organizationId, throughDate);
  const apOk = ap.total === apControl;
  items.push({
    key: 'ap_tie_out',
    label: 'AP aging ties to Accounts Payable',
    status: apOk ? 'pass' : 'fail',
    detail: apOk
      ? `Open items ${ap.total} = control ${apControl}`
      : `Open items ${ap.total} ≠ control ${apControl}`,
    value: apControl,
  });

  // 4. Inventory subledger ties to the Inventory Asset account. Layer
  //    remainders are current-state, so this check is evaluated as of now,
  //    not as of the close date.
  const inventoryGl = await systemAccountBalance(db, organizationId, 'inventory_asset');
  if (inventoryGl !== null) {
    const layerValue = roundMoney(
      await scalar(
        db,
        sql`SELECT COALESCE(SUM(remaining_value), 0)::text
            FROM inventory_layers WHERE organization_id = ${organizationId}`,
      ),
    );
    const invOk = inventoryGl === layerValue;
    items.push({
      key: 'inventory_tie_out',
      label: 'Inventory layers tie to Inventory Asset (as of now)',
      status: invOk ? 'pass' : 'fail',
      detail: invOk
        ? `Remaining layer value ${layerValue} = ledger ${inventoryGl}`
        : `Remaining layer value ${layerValue} ≠ ledger ${inventoryGl}`,
      value: inventoryGl,
    });
  }

  // 5. Draft documents dated in or before the period being closed. Drafts
  //    are off the books, so closing leaves them stranded behind a closed
  //    date — post or re-date them first.
  const draftCount = Number(
    await scalar(
      db,
      sql`SELECT (
            (SELECT COUNT(*) FROM invoices
             WHERE organization_id = ${organizationId}
               AND posting_status = 'draft' AND invoice_date <= ${throughDate}::date)
            + (SELECT COUNT(*) FROM credit_memos
               WHERE organization_id = ${organizationId}
                 AND posting_status = 'draft' AND credit_date <= ${throughDate}::date)
            + (SELECT COUNT(*) FROM bills
               WHERE organization_id = ${organizationId}
                 AND posting_status = 'draft' AND bill_date <= ${throughDate}::date)
            + (SELECT COUNT(*) FROM vendor_credits
               WHERE organization_id = ${organizationId}
                 AND posting_status = 'draft' AND credit_date <= ${throughDate}::date)
            + (SELECT COUNT(*) FROM manual_journals
               WHERE organization_id = ${organizationId}
                 AND posting_status = 'draft' AND journal_date <= ${throughDate}::date)
          )::text`,
    ),
  );
  items.push({
    key: 'draft_documents',
    label: 'No draft documents dated in the period',
    status: draftCount === 0 ? 'pass' : 'warning',
    detail:
      draftCount === 0
        ? 'Every document dated through the close date is posted or voided'
        : `${draftCount} draft document${draftCount === 1 ? '' : 's'} dated on or before ${throughDate} — post, re-date, or discard them first`,
  });

  // 6. Bills still waiting for approval.
  const pendingApprovals = Number(
    await scalar(
      db,
      sql`SELECT COUNT(*)::text FROM bills
          WHERE organization_id = ${organizationId}
            AND approval_status IN ('pending', 'partially_approved')
            AND bill_date <= ${throughDate}::date`,
    ),
  );
  items.push({
    key: 'pending_approvals',
    label: 'No bills awaiting approval in the period',
    status: pendingApprovals === 0 ? 'pass' : 'warning',
    detail:
      pendingApprovals === 0
        ? 'No approval queue for the period'
        : `${pendingApprovals} bill${pendingApprovals === 1 ? '' : 's'} dated on or before ${throughDate} still awaiting approval`,
  });

  // 7. Bank feed items still waiting for review.
  const feedForReview = Number(
    await scalar(
      db,
      sql`SELECT COUNT(*)::text FROM bank_feed_items
          WHERE organization_id = ${organizationId}
            AND state IN ('new', 'suggested', 'possible_duplicate', 'needs_info')
            AND txn_date <= ${throughDate}::date`,
    ),
  );
  items.push({
    key: 'bank_review_queue',
    label: 'Bank feed review queue is clear for the period',
    status: feedForReview === 0 ? 'pass' : 'warning',
    detail:
      feedForReview === 0
        ? 'No imported bank lines waiting for review'
        : `${feedForReview} imported bank line${feedForReview === 1 ? '' : 's'} dated on or before ${throughDate} still need review`,
  });

  // 8. Undeposited Funds — money received but not yet grouped into a deposit.
  const uf = await systemAccountBalance(db, organizationId, 'undeposited_funds', throughDate);
  if (uf !== null) {
    const ufOpen = cmp(uf, '0') !== 0;
    items.push({
      key: 'undeposited_funds',
      label: 'Undeposited Funds is cleared',
      status: ufOpen ? 'warning' : 'pass',
      detail: ufOpen
        ? `Undeposited Funds holds ${uf} as of ${throughDate} — record the bank deposits if they happened in the period`
        : 'All receipts have been deposited',
      value: uf,
    });
  }

  // 9. Opening Balance Equity should be reviewed and cleared to zero.
  const obe = await systemAccountBalance(db, organizationId, 'opening_balance_equity', throughDate);
  if (obe !== null) {
    const obeOpen = cmp(obe, '0') !== 0;
    items.push({
      key: 'opening_balance_equity',
      label: 'Opening Balance Equity is cleared',
      status: obeOpen ? 'warning' : 'pass',
      detail: obeOpen
        ? `Opening Balance Equity carries ${obe} — an accountant should reclassify it before the books are relied on`
        : 'Opening Balance Equity is zero',
      value: obe,
    });
  }

  return {
    throughDate,
    ready: items.every((i) => i.status !== 'fail'),
    items,
  };
}
