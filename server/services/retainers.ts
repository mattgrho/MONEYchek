import { and, eq, sql } from 'drizzle-orm';
import { cmp, roundMoney, sub, sum } from '@shared/money';
import type { Db, Tx } from '../db/client';
import {
  accounts,
  customerRetainers,
  customers,
  invoices,
  retainerApplications,
} from '../db/schema/index';
import { AppError } from '../lib/errors';
import { runFinancialCommand } from '../accounting/idempotency';
import { postEntry, reverseEntry } from '../accounting/posting';
import { ensureSystemAccounts, getSystemAccountId } from '../accounting/accounts';
import { nextDocumentNumber } from '../accounting/sequences';
import type { OrgContext } from './identity';
import { invoiceOpenBalance } from './invoices';

/**
 * Customer retainers (client deposits / prepayments held on account).
 *
 * Receiving: Dr Bank, Cr Customer Retainers (liability, per-customer party).
 * Applying to an invoice: Dr Customer Retainers, Cr Accounts Receivable —
 * the invoice's open balance falls exactly like a payment allocation.
 * History is append-only: unapply writes a reversing application row plus a
 * reversing journal entry; nothing is edited in place.
 */

async function retainerLiabilityAccountId(tx: Tx, organizationId: string): Promise<string> {
  const [row] = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.organizationId, organizationId),
        eq(accounts.systemKey, 'customer_retainers'),
      ),
    )
    .limit(1);
  if (row) return row.id;
  // Orgs onboarded before the retainer module gained the account get it on
  // first use (idempotent; creates only what is missing).
  const ids = await ensureSystemAccounts(tx, organizationId);
  const id = ids['customer_retainers'];
  if (!id) throw AppError.internal('Customer Retainers account could not be created');
  return id;
}

/** Remaining balance = amount - net applications (as of an optional date). */
export async function retainerBalance(tx: Tx, retainerId: string, asOf?: string): Promise<string> {
  const result = await tx.execute(sql`
    SELECT r.amount
      - COALESCE((SELECT SUM(ra.amount) FROM retainer_applications ra
                  WHERE ra.retainer_id = r.id
                  ${asOf ? sql`AND ra.effective_date <= ${asOf}::date` : sql``}), 0)
      AS balance
    FROM customer_retainers r WHERE r.id = ${retainerId}
  `);
  const row = result.rows[0] as { balance: string } | undefined;
  if (!row) throw AppError.notFound('Retainer not found');
  return roundMoney(row.balance);
}

export async function receiveRetainer(
  db: Db,
  ctx: OrgContext,
  input: {
    customerId: string;
    receivedDate: string;
    amount: string;
    depositToAccountId: string;
    method?: string;
    reference?: string;
    memo?: string;
    idempotencyKey: string;
  },
  correlationId: string,
): Promise<{ id: string; number: string; journalEntryId: string }> {
  if (cmp(input.amount, '0') <= 0) {
    throw AppError.validation('Retainer amount must be positive');
  }
  const { result } = await runFinancialCommand(
    db,
    {
      organizationId: ctx.organizationId,
      idempotencyKey: input.idempotencyKey,
      commandType: 'retainer.receive',
      payload: input,
      actorUserId: ctx.userId,
    },
    async (tx) => {
      const [customer] = await tx
        .select()
        .from(customers)
        .where(
          and(eq(customers.id, input.customerId), eq(customers.organizationId, ctx.organizationId)),
        )
        .limit(1);
      if (!customer) throw AppError.validation('Unknown customer');
      const [account] = await tx
        .select()
        .from(accounts)
        .where(
          and(
            eq(accounts.id, input.depositToAccountId),
            eq(accounts.organizationId, ctx.organizationId),
          ),
        )
        .limit(1);
      if (!account) throw AppError.validation('Unknown deposit-to account');
      if (account.systemKey) {
        throw AppError.unprocessable(
          'CONTROL_ACCOUNT_PROTECTED',
          'Retainers must be deposited into a bank account, not a controlled account',
        );
      }
      const liabilityId = await retainerLiabilityAccountId(tx, ctx.organizationId);
      const number = await nextDocumentNumber(tx, ctx.organizationId, 'retainer');
      const [retainer] = await tx
        .insert(customerRetainers)
        .values({
          organizationId: ctx.organizationId,
          number,
          customerId: input.customerId,
          receivedDate: input.receivedDate,
          amount: roundMoney(input.amount),
          depositToAccountId: input.depositToAccountId,
          method: input.method ?? null,
          reference: input.reference ?? null,
          memo: input.memo ?? null,
        })
        .returning();
      const entry = await postEntry(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        sourceType: 'retainer',
        sourceId: retainer!.id,
        postingDate: input.receivedDate,
        memo: `Retainer ${number}`,
        correlationId,
        auditAction: 'retainer.received',
        auditPayload: { number, amount: roundMoney(input.amount) },
        lines: [
          { accountId: input.depositToAccountId, debit: input.amount, memo: `Retainer ${number}` },
          {
            accountId: liabilityId,
            credit: input.amount,
            partyType: 'customer',
            partyId: input.customerId,
            memo: `Retainer ${number}`,
          },
        ],
      });
      await tx
        .update(customerRetainers)
        .set({
          postingStatus: 'posted',
          journalEntryId: entry.id,
          postedAt: new Date(),
          postedByUserId: ctx.userId,
        })
        .where(eq(customerRetainers.id, retainer!.id));
      return { id: retainer!.id, number, journalEntryId: entry.id };
    },
  );
  return result;
}

export async function applyRetainer(
  db: Db,
  ctx: OrgContext,
  retainerId: string,
  input: {
    allocations: { invoiceId: string; amount: string }[];
    effectiveDate: string;
    idempotencyKey: string;
  },
  correlationId: string,
): Promise<{ journalEntryId: string }> {
  const { result } = await runFinancialCommand(
    db,
    {
      organizationId: ctx.organizationId,
      idempotencyKey: input.idempotencyKey,
      commandType: 'retainer.apply',
      payload: { retainerId, ...input },
      actorUserId: ctx.userId,
    },
    async (tx) => {
      const [retainer] = await tx
        .select()
        .from(customerRetainers)
        .where(
          and(
            eq(customerRetainers.id, retainerId),
            eq(customerRetainers.organizationId, ctx.organizationId),
          ),
        )
        .for('update')
        .limit(1);
      if (!retainer || retainer.postingStatus !== 'posted') {
        throw AppError.notFound('Posted retainer not found');
      }
      const requested = roundMoney(sum(input.allocations.map((a) => a.amount)));
      const balance = await retainerBalance(tx, retainerId);
      if (cmp(requested, balance) > 0) {
        throw AppError.unprocessable(
          'OVER_APPLICATION',
          `Only ${balance} of this retainer remains; cannot apply ${requested}`,
        );
      }
      for (const alloc of input.allocations) {
        if (cmp(alloc.amount, '0') <= 0) {
          throw AppError.unprocessable('INVALID_ALLOCATION', 'Allocations must be positive');
        }
        const [invoice] = await tx
          .select()
          .from(invoices)
          .where(
            and(eq(invoices.id, alloc.invoiceId), eq(invoices.organizationId, ctx.organizationId)),
          )
          .for('update')
          .limit(1);
        if (!invoice || invoice.postingStatus !== 'posted') {
          throw AppError.unprocessable(
            'INVALID_ALLOCATION',
            'Allocations must target posted invoices',
          );
        }
        if (invoice.customerId !== retainer.customerId) {
          throw AppError.unprocessable(
            'INVALID_ALLOCATION',
            'Retainers can only be applied to the same customer’s invoices',
          );
        }
        if (
          input.effectiveDate < invoice.invoiceDate ||
          input.effectiveDate < retainer.receivedDate
        ) {
          throw AppError.validation(
            'The application date cannot be before the invoice or retainer date',
          );
        }
        const open = await invoiceOpenBalance(tx, invoice.id);
        if (cmp(alloc.amount, open) > 0) {
          throw AppError.unprocessable(
            'OVER_APPLICATION',
            `Invoice ${invoice.number} has only ${open} open; cannot apply ${alloc.amount}`,
          );
        }
      }

      const liabilityId = await retainerLiabilityAccountId(tx, ctx.organizationId);
      const arId = await getSystemAccountId(tx, ctx.organizationId, 'accounts_receivable');
      const entry = await postEntry(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        sourceType: 'retainer_application',
        sourceId: retainerId,
        postingDate: input.effectiveDate,
        memo: `Retainer ${retainer.number} applied`,
        correlationId,
        auditAction: 'retainer.applied',
        auditPayload: {
          number: retainer.number,
          amount: requested,
          invoices: input.allocations.map((a) => a.invoiceId),
        },
        lines: [
          {
            accountId: liabilityId,
            debit: requested,
            partyType: 'customer',
            partyId: retainer.customerId,
            memo: `Retainer ${retainer.number} applied`,
          },
          {
            accountId: arId,
            credit: requested,
            partyType: 'customer',
            partyId: retainer.customerId,
            memo: `Retainer ${retainer.number} applied`,
          },
        ],
      });
      for (const alloc of input.allocations) {
        await tx.insert(retainerApplications).values({
          organizationId: ctx.organizationId,
          retainerId,
          invoiceId: alloc.invoiceId,
          amount: roundMoney(alloc.amount),
          effectiveDate: input.effectiveDate,
          journalEntryId: entry.id,
          createdByUserId: ctx.userId,
        });
      }
      return { journalEntryId: entry.id };
    },
  );
  return result;
}

export async function unapplyRetainerApplication(
  db: Db,
  ctx: OrgContext,
  applicationId: string,
  input: { effectiveDate: string; idempotencyKey: string },
  correlationId: string,
): Promise<{ journalEntryId: string }> {
  const { result } = await runFinancialCommand(
    db,
    {
      organizationId: ctx.organizationId,
      idempotencyKey: input.idempotencyKey,
      commandType: 'retainer.unapply',
      payload: { applicationId, effectiveDate: input.effectiveDate },
      actorUserId: ctx.userId,
    },
    async (tx) => {
      const [application] = await tx
        .select()
        .from(retainerApplications)
        .where(
          and(
            eq(retainerApplications.id, applicationId),
            eq(retainerApplications.organizationId, ctx.organizationId),
          ),
        )
        .limit(1);
      if (!application) throw AppError.notFound('Retainer application not found');
      if (application.reversalOfApplicationId !== null) {
        throw AppError.conflict('ALREADY_REVERSED', 'This row is itself a reversal');
      }
      const [existingReversal] = await tx
        .select({ id: retainerApplications.id })
        .from(retainerApplications)
        .where(eq(retainerApplications.reversalOfApplicationId, applicationId))
        .limit(1);
      if (existingReversal) {
        throw AppError.conflict('ALREADY_REVERSED', 'This application was already unapplied');
      }
      if (input.effectiveDate < application.effectiveDate) {
        throw AppError.validation('The unapply date cannot be before the application date');
      }
      const [retainer] = await tx
        .select()
        .from(customerRetainers)
        .where(eq(customerRetainers.id, application.retainerId))
        .for('update')
        .limit(1);
      if (!retainer) throw AppError.notFound('Retainer not found');

      const liabilityId = await retainerLiabilityAccountId(tx, ctx.organizationId);
      const arId = await getSystemAccountId(tx, ctx.organizationId, 'accounts_receivable');
      const entry = await postEntry(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        sourceType: 'retainer_application',
        sourceId: retainer.id,
        postingDate: input.effectiveDate,
        memo: `Retainer ${retainer.number} unapplied`,
        correlationId,
        auditAction: 'retainer.unapplied',
        auditPayload: { number: retainer.number, amount: roundMoney(application.amount) },
        lines: [
          {
            accountId: arId,
            debit: application.amount,
            partyType: 'customer',
            partyId: retainer.customerId,
            memo: `Retainer ${retainer.number} unapplied`,
          },
          {
            accountId: liabilityId,
            credit: application.amount,
            partyType: 'customer',
            partyId: retainer.customerId,
            memo: `Retainer ${retainer.number} unapplied`,
          },
        ],
      });
      await tx.insert(retainerApplications).values({
        organizationId: ctx.organizationId,
        retainerId: application.retainerId,
        invoiceId: application.invoiceId,
        amount: roundMoney(sub('0', application.amount)),
        effectiveDate: input.effectiveDate,
        reversalOfApplicationId: applicationId,
        journalEntryId: entry.id,
        createdByUserId: ctx.userId,
      });
      return { journalEntryId: entry.id };
    },
  );
  return result;
}

/** Void requires the full amount unapplied; reverses the receipt entry. */
export async function voidRetainer(
  db: Db,
  ctx: OrgContext,
  retainerId: string,
  input: { reason: string; idempotencyKey: string },
  correlationId: string,
): Promise<{ reversalEntryId: string }> {
  const { result } = await runFinancialCommand(
    db,
    {
      organizationId: ctx.organizationId,
      idempotencyKey: input.idempotencyKey,
      commandType: 'retainer.void',
      payload: { retainerId, reason: input.reason },
      actorUserId: ctx.userId,
    },
    async (tx) => {
      const [retainer] = await tx
        .select()
        .from(customerRetainers)
        .where(
          and(
            eq(customerRetainers.id, retainerId),
            eq(customerRetainers.organizationId, ctx.organizationId),
          ),
        )
        .for('update')
        .limit(1);
      if (!retainer || retainer.postingStatus !== 'posted' || !retainer.journalEntryId) {
        throw AppError.notFound('Posted retainer not found');
      }
      const balance = await retainerBalance(tx, retainerId);
      if (cmp(balance, retainer.amount) !== 0) {
        throw AppError.unprocessable(
          'RETAINER_HAS_APPLICATIONS',
          'Unapply this retainer from its invoices before voiding it',
        );
      }
      const reversal = await reverseEntry(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        entryId: retainer.journalEntryId,
        postingDate: retainer.receivedDate,
        reason: input.reason,
        correlationId,
        linkKind: 'void',
      });
      await tx
        .update(customerRetainers)
        .set({
          postingStatus: 'voided',
          voidedAt: new Date(),
          voidedByUserId: ctx.userId,
          voidReason: input.reason,
          updatedAt: new Date(),
        })
        .where(eq(customerRetainers.id, retainerId));
      return { reversalEntryId: reversal.id };
    },
  );
  return result;
}
