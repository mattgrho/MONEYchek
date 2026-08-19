import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Formats a canonical decimal string for display WITHOUT converting through
 * binary floating point. Grouping and decimals are string operations.
 */
export function formatMoney(value: string | null | undefined, currency = 'USD'): string {
  if (value === null || value === undefined || value === '') return '—';
  if (!/^-?\d+(\.\d+)?$/.test(value)) return value;
  const negative = value.startsWith('-');
  const [rawInt = '0', rawDec = ''] = (negative ? value.slice(1) : value).split('.');
  const int = rawInt.replace(/^0+(?=\d)/, '');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const decimals = (rawDec + '00').slice(0, 2);
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  const core = `${symbol}${grouped}.${decimals}`;
  return negative ? `-${core}` : core;
}

/** Same but for quantities: trims trailing zeros, no symbol. */
export function formatQuantity(value: string | null | undefined): string {
  if (!value) return '—';
  if (!/^-?\d+(\.\d+)?$/.test(value)) return value;
  const [int = '0', dec = ''] = value.split('.');
  const trimmed = dec.replace(/0+$/, '');
  return trimmed ? `${int}.${trimmed}` : int;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = iso.slice(0, 10);
  const [y, m, day] = d.split('-');
  if (!y || !m || !day) return iso;
  return `${m}/${day}/${y}`;
}

export function todayISO(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
