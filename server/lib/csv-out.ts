/**
 * CSV output with spreadsheet-formula-injection protection: text cells that
 * begin with =, +, -, @, tab, or CR are prefixed with a single quote. Typed
 * numeric cells (canonical decimal strings) stay numeric.
 */

const DANGEROUS = /^[=+\-@\t\r]/;
const NUMERIC = /^-?\d+(\.\d+)?$/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (NUMERIC.test(s)) return s;
  if (DANGEROUS.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return lines.join('\r\n') + '\r\n';
}
