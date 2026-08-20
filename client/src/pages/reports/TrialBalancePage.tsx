import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Me } from '@/lib/types';
import { formatDate, formatMoney, todayISO } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Badge, ErrorNote, Label, PageHeader, Spinner } from '@/components/ui/primitives';
import { Table, TBody, TD, TDMoney, TFoot, TH, THead, TR } from '@/components/ui/table';

interface TrialBalanceRow {
  accountId: string;
  number: string | null;
  name: string;
  debit: string;
  credit: string;
}
interface TrialBalanceReport {
  asOf: string;
  rows: TrialBalanceRow[];
  totalDebits: string;
  totalCredits: string;
}

function isZero(value: string): boolean {
  return /^-?0(\.0+)?$/.test(value);
}

export function TrialBalancePage({ me }: { me: Me }) {
  const currency = me.company?.homeCurrency ?? 'USD';
  const [asOf, setAsOf] = useState(todayISO());

  const report = useQuery({
    queryKey: ['trial-balance', asOf],
    queryFn: () =>
      api.get<TrialBalanceReport>(`/api/v1/reports/trial-balance?asOf=${encodeURIComponent(asOf)}`),
    enabled: asOf.length > 0,
  });

  const data = report.data;
  const inBalance = data ? data.totalDebits === data.totalCredits : false;

  return (
    <div>
      <Link to="/reports" className="mb-3 inline-block text-sm text-primary underline">
        &larr; All reports
      </Link>
      <PageHeader
        title="Trial balance"
        description={`Account balances as of ${formatDate(asOf)}.`}
      />

      <div className="mb-5 flex flex-wrap items-end gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="tb-as-of">As of date</Label>
          <Input
            id="tb-as-of"
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            className="w-44"
          />
        </div>
        {data ? (
          inBalance ? (
            <Badge tone="success">In balance</Badge>
          ) : (
            <Badge tone="danger">Out of balance — debits do not equal credits</Badge>
          )
        ) : null}
      </div>

      {report.isLoading ? <Spinner label="Loading trial balance" /> : null}
      {report.error ? <ErrorNote error={report.error} /> : null}

      {data ? (
        data.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No account activity as of {formatDate(data.asOf)}.
          </p>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH className="w-28">Number</TH>
                <TH>Account</TH>
                <TH className="w-40 text-right">Debit</TH>
                <TH className="w-40 text-right">Credit</TH>
              </TR>
            </THead>
            <TBody>
              {data.rows.map((row) => (
                <TR key={row.accountId}>
                  <TD className="text-muted-foreground">{row.number ?? '—'}</TD>
                  <TD>{row.name}</TD>
                  <TDMoney>{isZero(row.debit) ? '' : formatMoney(row.debit, currency)}</TDMoney>
                  <TDMoney>{isZero(row.credit) ? '' : formatMoney(row.credit, currency)}</TDMoney>
                </TR>
              ))}
            </TBody>
            <TFoot>
              <TR>
                <TD />
                <TD>Totals</TD>
                <TDMoney>{formatMoney(data.totalDebits, currency)}</TDMoney>
                <TDMoney>{formatMoney(data.totalCredits, currency)}</TDMoney>
              </TR>
            </TFoot>
          </Table>
        )
      ) : null}
    </div>
  );
}
