import { add, lineNet, lineTax, roundMoney, sum } from '../money/index';

/**
 * Sales-document math, shared by server posting and client preview so totals
 * can never disagree. Policy (versioned in shared/money):
 *  - line net = quantity x unit rate at high precision, rounded half-up to
 *    the minor unit
 *  - tax computed and rounded per taxable line, then summed (frozen)
 */

export interface DocumentLineInput {
  quantity: string;
  unitPrice: string;
  taxable: boolean;
}

export interface ComputedDocumentLine extends DocumentLineInput {
  amount: string;
  taxAmount: string;
}

export interface DocumentTotals {
  lines: ComputedDocumentLine[];
  subtotal: string;
  taxableBase: string;
  taxTotal: string;
  total: string;
}

export function computeDocumentTotals(
  lines: readonly DocumentLineInput[],
  taxRateFraction: string | null,
): DocumentTotals {
  const computed = lines.map((line) => {
    const amount = lineNet(line.quantity, line.unitPrice);
    const taxAmount = line.taxable && taxRateFraction ? lineTax(amount, taxRateFraction) : '0.00';
    return { ...line, amount, taxAmount };
  });
  const subtotal = roundMoney(sum(computed.map((l) => l.amount)));
  const taxableBase = roundMoney(sum(computed.filter((l) => l.taxable).map((l) => l.amount)));
  const taxTotal = roundMoney(sum(computed.map((l) => l.taxAmount)));
  const total = roundMoney(add(subtotal, taxTotal));
  return { lines: computed, subtotal, taxableBase, taxTotal, total };
}
