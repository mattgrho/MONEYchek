import { and, eq } from 'drizzle-orm';
import { cmp, roundMoney } from '@shared/money';
import type { Db } from '../db/client';
import { accounts } from '../db/schema/index';
import { AppError } from '../lib/errors';
import { runFinancialCommand } from '../accounting/idempotency';
import { postEntry } from '../accounting/posting';
import { getSystemAccountId } from '../accounting/accounts';
import type { OrgContext } from './identity';

/**
 * Sales-tax remittance: the one non-document workflow the Sales Tax Payable
 * control account accepts (sourceType 'tax_payment'). Dr Sales Tax Payable,
 * Cr Bank — reducing the liability when the agency is paid.
 */
export async function recordTaxPayment(
  db: Db,
  ctx: OrgContext,
  input: {
    paymentDate: string;
    amount: string;
    bankAccountId: string;
    agencyName?: string;
    memo?: string;
    idempotencyKey: string;
  },
  correlationId: string,
): Promise<{ journalEntryId: string }> {
  if (cmp(input.amount, '0') <= 0) {
    throw AppError.validation('Tax payment amount must be positive');
  }
  const { result } = await runFinancialCommand(
    db,
    {
      organizationId: ctx.organizationId,
      idempotencyKey: input.idempotencyKey,
      commandType: 'tax_payment.create',
      payload: input,
      actorUserId: ctx.userId,
    },
    async (tx) => {
      const [bank] = await tx
        .select()
        .from(accounts)
        .where(
          and(
            eq(accounts.id, input.bankAccountId),
            eq(accounts.organizationId, ctx.organizationId),
          ),
        )
        .limit(1);
      if (!bank) throw AppError.validation('Unknown bank account');
      if (bank.systemKey) {
        throw AppError.unprocessable(
          'CONTROL_ACCOUNT_PROTECTED',
          'Tax payments must come from a bank account, not a controlled account',
        );
      }
      const taxAccountId = await getSystemAccountId(tx, ctx.organizationId, 'sales_tax_payable');
      const memo = input.memo
        ? input.memo
        : `Sales tax payment${input.agencyName ? ` — ${input.agencyName}` : ''}`;
      const entry = await postEntry(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        sourceType: 'tax_payment',
        sourceId: null,
        postingDate: input.paymentDate,
        memo,
        correlationId,
        auditAction: 'tax_payment.posted',
        auditPayload: {
          amount: roundMoney(input.amount),
          agencyName: input.agencyName ?? null,
        },
        lines: [
          { accountId: taxAccountId, debit: input.amount, memo },
          { accountId: input.bankAccountId, credit: input.amount, memo },
        ],
      });
      return { journalEntryId: entry.id };
    },
  );
  return result;
}
