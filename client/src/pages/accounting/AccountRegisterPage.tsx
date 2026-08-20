import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Check } from 'lucide-react';
import { api } from '@/lib/api';
import type { Me } from '@/lib/types';
import { formatDate, formatMoney, todayISO } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { ErrorNote, Label, PageHeader, Spinner } from '@/components/ui/primitives';
import { Table, TBody, TD, TDMoney, TFoot, TH, THead, TR } from '@/components/ui/table';

interface RegisterRow {
  entryId: string;
  entryNumber: string;
  postingDate: string;
  sourceType: string;
  memo: string | null;
  debit: string | null;
  credit: string | null;
  cleared: boolean;
  runningBalance: string;
  lineId: string;
}

interface RegisterResponse {
  account: { id: string; name: string; number: string | null; category: string };
  rows: RegisterRow[];
  endingBalance: string;
}

const SOURCE_TYPE_LABELS: Record<string, string> = {
  manual_journal: 'Manual journal',
  opening_balance: 'Opening balance',
  invoice: 'Invoice',
  payment: 'Payment',
  bill: 'Bill',
  bill_payment: 'Bill payment',
  deposit: 'Deposit',
  expense: 'Expense',
  reversal: 'Reversal',
};

function sourceTypeLabel(sourceType: string): string {
  const known = SOURCE_TYPE_LABELS[sourceType];
  if (known) return known;
  const words = sourceType.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function daysAgoISO(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Blank cell for the unused side of a register line instead of a dash. */
function isZeroOrEmpty(value: string | null): boolean {
  return !value || /^-?0(\.0+)?$/.test(value);
}

export function AccountRegisterPage({ me }: { me: Me }) {
  const { id } = useParams<{ id: string }>();
  const currency = me.company?.homeCurrency ?? 'USD';
  const [startDate, setStartDate] = useState(() => daysAgoISO(90));
  const [endDate, setEndDate] = useState(() => todayISO());

  const register = useQuery({
    queryKey: ['account-register', id, startDate, endDate],
    queryFn: () =>
      api.get<RegisterResponse>(
        `/api/v1/accounts/${id}/register?startDate=${encodeURIComponent(
          startDate,
        )}&endDate=${encodeURIComponent(endDate)}`,
      ),
    enabled: Boolean(id) && Boolean(startDate) && Boolean(endDate),
  });

  const account = register.data?.account;

  return (
    <div>
      <div className="mb-3">
        <Link
          to="/accounting/accounts"
          className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to chart of accounts
        </Link>
      </div>
      <PageHeader
        title={
          account
            ? `${account.number ? `${account.number} · ` : ''}${account.name}`
            : 'Account register'
        }
        description="Posted ledger activity for this account within the selected date range."
      />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="register-start">From</Label>
          <Input
            id="register-start"
            type="date"
            value={startDate}
            max={endDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="register-end">To</Label>
          <Input
            id="register-end"
            type="date"
            value={endDate}
            min={startDate}
            onChange={(e) => setEndDate(e.target.value)}
          />
        </div>
      </div>

      {register.isLoading ? (
        <Spinner label="Loading register" />
      ) : register.error ? (
        <ErrorNote error={register.error} />
      ) : register.data ? (
        <Table>
          <THead>
            <TR>
              <TH className="w-28">Date</TH>
              <TH className="w-28">Entry #</TH>
              <TH>Source</TH>
              <TH>Memo</TH>
              <TH className="w-12">Cleared</TH>
              <TH className="text-right">Debit</TH>
              <TH className="text-right">Credit</TH>
              <TH className="text-right">Balance</TH>
            </TR>
          </THead>
          <TBody>
            {register.data.rows.length === 0 ? (
              <TR>
                <TD colSpan={8} className="py-6 text-center text-sm text-muted-foreground">
                  No activity in this date range.
                </TD>
              </TR>
            ) : (
              register.data.rows.map((row) => (
                <TR key={row.lineId}>
                  <TD className="text-muted-foreground">{formatDate(row.postingDate)}</TD>
                  <TD className="font-mono text-xs">{row.entryNumber}</TD>
                  <TD>{sourceTypeLabel(row.sourceType)}</TD>
                  <TD
                    className="max-w-xs truncate text-muted-foreground"
                    title={row.memo ?? undefined}
                  >
                    {row.memo ?? ''}
                  </TD>
                  <TD>
                    {row.cleared ? (
                      <Check className="h-4 w-4 text-success" role="img" aria-label="Cleared" />
                    ) : (
                      <span className="sr-only">Not cleared</span>
                    )}
                  </TD>
                  <TDMoney>
                    {isZeroOrEmpty(row.debit) ? '' : formatMoney(row.debit, currency)}
                  </TDMoney>
                  <TDMoney>
                    {isZeroOrEmpty(row.credit) ? '' : formatMoney(row.credit, currency)}
                  </TDMoney>
                  <TDMoney>{formatMoney(row.runningBalance, currency)}</TDMoney>
                </TR>
              ))
            )}
          </TBody>
          <TFoot>
            <TR>
              <TD colSpan={7} className="text-right text-sm font-medium">
                Ending balance
              </TD>
              <TDMoney className="font-semibold">
                {formatMoney(register.data.endingBalance, currency)}
              </TDMoney>
            </TR>
          </TFoot>
        </Table>
      ) : null}
    </div>
  );
}
