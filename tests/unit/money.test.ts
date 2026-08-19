import { describe, expect, it } from 'vitest';
import {
  add,
  allocateProportionally,
  assertDecimalString,
  cmp,
  dec,
  isDecimalString,
  lineNet,
  lineTax,
  mul,
  normalize,
  roundMoney,
  sub,
  sum,
  toLedger,
} from '@shared/money';

describe('decimal string validation', () => {
  it('accepts canonical decimal strings', () => {
    for (const v of ['0', '1', '-1', '10.5', '-0.0001', '123456789.123456']) {
      expect(isDecimalString(v)).toBe(true);
    }
  });

  it('rejects numbers, exponents, and junk', () => {
    for (const v of [
      1,
      1.5,
      NaN,
      null,
      undefined,
      '',
      '1e5',
      '1,000',
      '$5',
      '1.',
      '.5',
      'abc',
      '+5',
    ]) {
      expect(isDecimalString(v)).toBe(false);
    }
    expect(() => assertDecimalString(12 as unknown as string)).toThrow();
  });
});

describe('exact arithmetic', () => {
  it('avoids binary float artifacts', () => {
    expect(add('0.1', '0.2')).toBe('0.3');
    expect(sub('0.3', '0.1')).toBe('0.2');
    expect(mul('0.1', '0.2')).toBe('0.02');
  });

  it('sums long lists exactly', () => {
    const values = Array.from({ length: 1000 }, () => '0.01');
    expect(sum(values)).toBe('10');
  });

  it('normalizes representations', () => {
    expect(normalize('10.0000')).toBe('10');
    expect(normalize('-0')).toBe('0');
    expect(cmp('10.00', '10')).toBe(0);
  });
});

describe('rounding policy: half-up away from zero', () => {
  it('rounds the golden dataset tax value 12.375 -> 12.38', () => {
    expect(roundMoney('12.375')).toBe('12.38');
  });

  it('rounds midpoints away from zero for negatives', () => {
    expect(roundMoney('-12.375')).toBe('-12.38');
    expect(roundMoney('-0.005')).toBe('-0.01');
  });

  it('formats fixed decimals', () => {
    expect(roundMoney('5')).toBe('5.00');
    expect(toLedger('5.5')).toBe('5.5000');
  });
});

describe('line and tax math', () => {
  it('computes quantity x rate then rounds', () => {
    expect(lineNet('15', '10')).toBe('150.00');
    expect(lineNet('3', '0.335')).toBe('1.01'); // 1.005 -> 1.01 half-up
  });

  it('computes the golden dataset tax exactly', () => {
    expect(lineTax('150', '0.0825')).toBe('12.38');
  });
});

describe('remainder allocation', () => {
  it('allocates with remainder to largest weight, sum exact', () => {
    const { shares } = allocateProportionally('100.00', ['1', '1', '1']);
    expect(shares.reduce((a, b) => add(a, b))).toBe('100');
    // largest weight tie -> lowest index gets the remainder
    expect(shares[0]).toBe('33.34');
    expect(shares[1]).toBe('33.33');
    expect(shares[2]).toBe('33.33');
  });

  it('handles zero weights by assigning everything to line one', () => {
    const { shares } = allocateProportionally('10.00', ['0', '0']);
    expect(shares[0]).toBe('10.00');
    expect(shares[1]).toBe('0.00');
  });

  it('is exact for adversarial penny splits', () => {
    const { shares } = allocateProportionally('0.01', ['1', '1', '1']);
    expect(sum(shares)).toBe('0.01');
  });
});

describe('dec()', () => {
  it('refuses non-strings', () => {
    expect(() => dec(0.1 as unknown as string)).toThrow();
  });
});
