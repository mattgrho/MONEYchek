import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { api } from '@/lib/api';
import type { Me } from '@/lib/types';
import { formatDate, formatMoney, todayISO } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import {
  EmptyState,
  ErrorNote,
  Label,
  PageHeader,
  Select,
  Spinner,
} from '@/components/ui/primitives';
import { Table, TBody, TD, TDMoney, TFoot, TH, THead, TR } from '@/components/ui/table';

interface BankingAccount {
  accountId: string;
  kind: 'bank' | 'credit_card';
  institutionName: string | null;
  accountMask: string | null;
  name: string;
  number: string | null;
  bookBalance: string;
  clearedBalance: string;
  reconciledThrough: string | null;
  lastStatementBalance: string | null;
}

interface RegisterRow {
  entryId: string;
  entryNumber: string;
  postingDate: string;
  sourceType: string;
  memo: string | null;
  debit: string;
  credit: string;
  cleared: boolean;
  runningBalance: string;
  lineId: string;
}

interface RegisterResponse {
  account: { id: string; name: string; number: string | null; category: string };
  rows: RegisterRow[];
  endingBalance: string;
}

// ---------------------------------------------------------------------------
// Exact decimal string math (BigInt; floats are never involved).
// ---------------------------------------------------------------------------

/** Parses a decimal string into unscaled integer digits + decimal scale. */
function scaledParts(value: string): { n: bigint; scale: number } {
  const t = value.trim();
  if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(t)) return { n: 0n, scale: 0 };
  const negative = t.startsWith('-');
  const unsigned = negative ? t.slice(1) : t;
  const [intPart = '', decPart = ''] = unsigned.split('.');
  const n = BigInt((intPart === '' ? '0' : intPart) + decPart);
  return { n: negative ? -n : n, scale: decPart.length };
}

/** Integer division rounded half-up (denominator must be positive). */
function roundHalfUpDiv(num: bigint, denom: bigint): bigint {
  const negative = num < 0n;
  const abs = negative ? -num : num;
  const q = abs / denom;
  const r = abs % denom;
  const rounded = r * 2n >= denom ? q + 1n : q;
  return negative ? -rounded : rounded;
}

/** Amount in cents, scaled to 2dp. Rounds half-up when the input has >2dp. */
function toCents(value: string): bigint {
  const { n, scale } = scaledParts(value);
  if (scale <= 2) return n * 10n ** BigInt(2 - scale);
  return roundHalfUpDiv(n, 10n ** BigInt(scale - 2));
}

function centsToDecimalString(cents: bigint): string {
  const negative = cents < 0n;
  const abs = (negative ? -cents : cents).toString().padStart(3, '0');
  return `${negative ? '-' : ''}${abs.slice(0, -2)}.${abs.slice(-2)}`;
}

/** Flips the sign of a decimal string ('175.00' <-> '-175.00'); zero stays '0.00'. */
function negateMoney(value: string): string {
  return centsToDecimalString(-toCents(value));
}

/** 'YYYY-MM-DD' + N days (may be negative), computed in UTC so DST never shifts the date. */
function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d || Number.isNaN(y + m + d)) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/** 'invoice' -> 'Invoice', 'bill_payment' -> 'Bill payment'. */
function sourceTypeLabel(sourceType: string): string {
  const words = sourceType.replace(/_/g, ' ').trim();
  return words === '' ? '—' : words.charAt(0).toUpperCase() + words.slice(1);
}

function accountOptionLabel(a: BankingAccount): string {
  const base = a.number ? `${a.number} · ${a.name}` : a.name;
  const suffix =
    a.institutionName || a.accountMask
      ? ` (${[a.institutionName, a.accountMask ? `···${a.accountMask}` : null]
          .filter(Boolean)
          .join(' ')})`
      : '';
  return `${base}${suffix}`;
}

export function RegistersPage({ me }: { me: Me }) {
  const currency = me.company?.homeCurrency ?? 'USD';
  const today = todayISO();

  const [accountId, setAccountId] = useState('');
  const [startDate, setStartDate] = useState(addDaysISO(today, -90));
  const [endDate, setEndDate] = useState(today);

  const bankAccounts = useQuery({
    queryKey: ['banking-accounts'],
    queryFn: () => api.get<{ items: BankingAccount[] }>('/api/v1/banking/accounts'),
  });

  const accountItems = bankAccounts.data?.items ?? [];
  const effectiveAccountId = accountId !== '' ? accountId : (accountItems[0]?.accountId ?? '');
  const selectedAccount = accountItems.find((a) => a.accountId === effectiveAccountId) ?? null;
  const isCard = selectedAccount?.kind === 'credit_card';
  const datesValid = startDate !== '' && endDate !== '' && startDate <= endDate;

  const register = useQuery({
    queryKey: ['register', effectiveAccountId, startDate, endDate],
    queryFn: () =>
      api.get<RegisterResponse>(
        `/api/v1/accounts/${effectiveAccountId}/register?startDate=${encodeURIComponent(
          startDate,
        )}&endDate=${encodeURIComponent(endDate)}`,
      ),
    enabled: effectiveAccountId !== '' && datesValid,
  });

  // Credit cards run as ledger liabilities (credit-normal); display the
  // running balance and book balance as the positive amount owed.
  const displayRunning = (value: string) => (isCard ? negateMoney(value) : value);

  if (bankAccounts.isLoading) return <Spinner label="Loading accounts" />;
  if (bankAccounts.error) return <ErrorNote error={bankAccounts.error} />;

  const rows = register.data?.rows ?? [];

  return (
    <div>
      <PageHeader
        title="Registers"
        description="Every posted transaction in a bank or credit-card account, checkbook style, with a running balance."
      />

      {accountItems.length === 0 ? (
        <EmptyState
          title="No bank or credit-card accounts"
          description="Add a bank or credit-card account to the chart of accounts to see its register."
        />
      ) : (
        <>
          <div className="mb-4 grid gap-4 sm:max-w-2xl sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="reg-account">Account</Label>
              <Select
                id="reg-account"
                value={effectiveAccountId}
                onChange={(e) => setAccountId(e.target.value)}
              >
                {accountItems.map((a) => (
                  <option key={a.accountId} value={a.accountId}>
                    {accountOptionLabel(a)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="reg-start">From</Label>
              <Input
                id="reg-start"
                type="date"
                required
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="reg-end">To</Label>
              <Input
                id="reg-end"
                type="date"
                required
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>

          {!datesValid ? (
            <p className="mb-4 text-sm text-destructive" role="alert">
              Enter a valid date range: the start date must be on or before the end date.
            </p>
          ) : register.isLoading ? (
            <Spinner label="Loading register" />
          ) : register.error ? (
            <ErrorNote error={register.error} />
          ) : rows.length === 0 ? (
            <EmptyState
              title="No transactions in this range"
              description="Nothing posted to this account between the selected dates."
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Date</TH>
                  <TH>Entry #</TH>
                  <TH>Source</TH>
                  <TH>Memo</TH>
                  {/* Bank: credit = money out (Payment), debit = money in (Deposit).
                      Credit card: credit = new charge, debit = payment toward the card. */}
                  <TH className="text-right">{isCard ? 'Charge' : 'Payment'}</TH>
                  <TH className="text-right">{isCard ? 'Payment' : 'Deposit'}</TH>
                  <TH className="w-12 text-center">
                    <span className="sr-only">Cleared</span>
                    <Check className="mx-auto h-3.5 w-3.5" aria-hidden />
                  </TH>
                  <TH className="text-right">Balance</TH>
                </TR>
              </THead>
              <TBody>
                {rows.map((row) => (
                  <TR key={row.lineId}>
                    <TD className="text-muted-foreground">{formatDate(row.postingDate)}</TD>
                    <TD className="font-mono text-[13px]">{row.entryNumber}</TD>
                    <TD>{sourceTypeLabel(row.sourceType)}</TD>
                    <TD className="max-w-[280px] truncate text-muted-foreground">
                      {row.memo ?? '—'}
                    </TD>
                    <TDMoney>
                      {toCents(row.credit) !== 0n ? formatMoney(row.credit, currency) : '—'}
                    </TDMoney>
                    <TDMoney>
                      {toCents(row.debit) !== 0n ? formatMoney(row.debit, currency) : '—'}
                    </TDMoney>
                    <TD className="text-center">
                      {row.cleared ? (
                        <Check
                          className="mx-auto h-4 w-4 text-success"
                          role="img"
                          aria-label="Cleared"
                        />
                      ) : (
                        <span className="sr-only">Not cleared</span>
                      )}
                    </TD>
                    <TDMoney>{formatMoney(displayRunning(row.runningBalance), currency)}</TDMoney>
                  </TR>
                ))}
              </TBody>
              <TFoot>
                <TR>
                  <TD
                    colSpan={7}
                    className="text-right text-xs uppercase tracking-wide text-muted-foreground"
                  >
                    Book balance{isCard ? ' (amount owed)' : ''}
                  </TD>
                  <TDMoney className="font-semibold">
                    {formatMoney(displayRunning(register.data?.endingBalance ?? '0.00'), currency)}
                  </TDMoney>
                </TR>
              </TFoot>
            </Table>
          )}
        </>
      )}
    </div>
  );
}
