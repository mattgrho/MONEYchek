import { Decimal } from 'decimal.js';

/**
 * Exact-decimal money arithmetic.
 *
 * Every monetary or rate value crosses process boundaries as a canonical
 * decimal STRING and is computed with decimal.js. JavaScript binary floats are
 * never used for money. PostgreSQL stores NUMERIC and the pg driver returns
 * strings, so values stay exact end to end.
 *
 * Rounding policy (Prototype Core, versioned as ROUNDING_POLICY_VERSION):
 * round-half-up (midpoint away from zero) to the currency minor unit.
 */

export const ROUNDING_POLICY_VERSION = 'half-up-v1';

// A dedicated constructor so global Decimal configuration elsewhere cannot
// change financial semantics.
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

export class MoneyError extends Error {
  override readonly name = 'MoneyError';
}

/** Validates a canonical decimal string ("-12.34", "0", "1000.5"). */
export function isDecimalString(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL_RE.test(value);
}

export function assertDecimalString(value: unknown, field = 'amount'): string {
  if (!isDecimalString(value)) {
    throw new MoneyError(
      `${field} must be a canonical decimal string, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** Parses a canonical decimal string into a Decimal. Rejects numbers on purpose. */
export function dec(value: string, field = 'amount'): Decimal {
  assertDecimalString(value, field);
  return new D(value);
}

export function add(a: string, b: string): string {
  return dec(a).plus(dec(b)).toString();
}

export function sub(a: string, b: string): string {
  return dec(a).minus(dec(b)).toString();
}

/** High-precision multiply (no rounding); round explicitly afterwards. */
export function mul(a: string, b: string): string {
  return dec(a).times(dec(b)).toString();
}

export function div(a: string, b: string): string {
  const divisor = dec(b);
  if (divisor.isZero()) throw new MoneyError('division by zero');
  return dec(a).div(divisor).toString();
}

export function neg(a: string): string {
  return dec(a).negated().toString();
}

export function abs(a: string): string {
  return dec(a).abs().toString();
}

/** -1 | 0 | 1 */
export function cmp(a: string, b: string): number {
  return dec(a).comparedTo(dec(b));
}

export function eq(a: string, b: string): boolean {
  return cmp(a, b) === 0;
}

export function isZero(a: string): boolean {
  return dec(a).isZero();
}

export function isNegative(a: string): boolean {
  return dec(a).isNegative() && !dec(a).isZero();
}

export function isPositive(a: string): boolean {
  return dec(a).greaterThan(0);
}

export function min(a: string, b: string): string {
  return cmp(a, b) <= 0 ? normalize(a) : normalize(b);
}

export function max(a: string, b: string): string {
  return cmp(a, b) >= 0 ? normalize(a) : normalize(b);
}

/** Strips trailing zeros / normalizes "-0" and "10.00" -> "10". */
export function normalize(a: string): string {
  return dec(a).toString();
}

/**
 * Rounds to the currency minor unit (2 for USD) using round-half-up with the
 * midpoint moving away from zero, and formats with exactly `decimals` places.
 */
export function roundMoney(a: string, decimals = 2): string {
  return dec(a).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP).toFixed(decimals);
}

/** Ledger canonical form: fixed 4 decimal places (NUMERIC(20,4)). */
export function toLedger(a: string): string {
  return dec(a).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);
}

/** Sum of decimal strings ("0" for empty). */
export function sum(values: readonly string[]): string {
  let acc = new D(0);
  for (const v of values) acc = acc.plus(dec(v));
  return acc.toString();
}

/**
 * Allocates `target` across `weights` proportionally, rounding each share to
 * `decimals`, and assigns any unavoidable final minor-unit remainder to the
 * largest eligible absolute weight (ties broken by the LOWEST index — stable
 * line-number order).
 *
 * Returns shares whose exact sum equals roundMoney(target, decimals).
 */
export function allocateProportionally(
  target: string,
  weights: readonly string[],
  decimals = 2,
): { shares: string[]; remainderIndex: number | null; remainder: string } {
  if (weights.length === 0)
    throw new MoneyError('allocateProportionally requires at least one weight');
  const targetD = dec(target).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);
  const totalWeight = weights.reduce((acc, w) => acc.plus(dec(w)), new D(0));
  if (totalWeight.isZero()) {
    // Nothing to weight against: everything to the first line.
    const shares = weights.map(() => new D(0).toFixed(decimals));
    shares[0] = targetD.toFixed(decimals);
    return {
      shares,
      remainderIndex: targetD.isZero() ? null : 0,
      remainder: targetD.toFixed(decimals),
    };
  }
  const raw = weights.map((w) =>
    targetD.times(dec(w)).div(totalWeight).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP),
  );
  const rawSum = raw.reduce((acc, r) => acc.plus(r), new D(0));
  const remainder = targetD.minus(rawSum);
  let remainderIndex: number | null = null;
  if (!remainder.isZero()) {
    let best = -1;
    let bestAbs: Decimal | null = null;
    for (let i = 0; i < weights.length; i++) {
      const a = dec(weights[i]!).abs();
      if (bestAbs === null || a.greaterThan(bestAbs)) {
        bestAbs = a;
        best = i;
      }
    }
    remainderIndex = best;
    raw[best] = raw[best]!.plus(remainder);
  }
  return {
    shares: raw.map((r) => r.toFixed(decimals)),
    remainderIndex,
    remainder: remainder.toFixed(decimals),
  };
}

/**
 * line net = quantity x unit rate at high precision, rounded to minor unit.
 */
export function lineNet(quantity: string, unitRate: string, decimals = 2): string {
  return roundMoney(mul(quantity, unitRate), decimals);
}

/**
 * Tax for one taxable line: base x rate (rate as decimal fraction, e.g. "0.0825"),
 * rounded per line to the minor unit.
 */
export function lineTax(taxableBase: string, rateFraction: string, decimals = 2): string {
  return roundMoney(mul(taxableBase, rateFraction), decimals);
}
