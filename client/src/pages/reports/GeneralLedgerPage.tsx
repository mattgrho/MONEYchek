import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Me } from '@/lib/types';
import { formatDate, formatMoney, todayISO } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorNote,
  Label,
  PageHeader,
  Select,
  Spinner,
} from '@/components/ui/primitives';
import { Table, TBody, TD, TDMoney, TFoot, TH, THead, TR } from '@/components/ui/table';

interface AccountOption {
  id: string;
  number: string | null;
  name: string;
  category: string;
  active: boolean;
}
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
interface LedgerAccount {
  accountId: string;
  number: string | null;
  name: string;
  category: string;
  openingBalance: string;
  rows: RegisterRow[];
  endingBalance: string;
}
interface GeneralLedgerReport {
  startDate: string;
  endDate: string;
  accounts: LedgerAccount[];
}

export function GeneralLedgerPage({ me }: { me: Me }) {
  const currency = me.company?.homeCurrency ?? 'USD';
  const [startDate, setStartDate] = useState(`${new Date().getFullYear()}-01-01`);
  const [endDate, setEndDate] = useState(todayISO());
  const [accountId, setAccountId] = useState('');

  const accounts = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api.get<{ items: AccountOption[] }>('/api/v1/accounts'),
  });

  const report = useQuery({
    queryKey: ['general-ledger', startDate, endDate, accountId],
    queryFn: () => {
      const params = new URLSearchParams({ startDate, endDate });
      if (accountId) params.set('accountId', accountId);
      return api.get<GeneralLedgerReport>(`/api/v1/reports/general-ledger?${params.toString()}`);
    },
    enabled: startDate.length > 0 && endDate.length > 0,
  });

  const data = report.data;
  const accountItems = accounts.data?.items ?? [];

  return (
    <div>
      <Link to="/reports" className="mb-3 inline-block text-sm text-primary underline">
        &larr; All reports
      </Link>
      <PageHeader
        title="General ledger"
        description={`Posted activity by account from ${formatDate(startDate)} to ${formatDate(
          endDate,
        )}.`}
      />

      <div className="mb-5 flex flex-wrap items-end gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="gl-start">Start date</Label>
          <Input
            id="gl-start"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="w-44"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="gl-end">End date</Label>
          <Input
            id="gl-end"
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="w-44"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="gl-account">Account</Label>
          <Select
            id="gl-account"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className="w-72"
          >
            <option value="">All accounts</option>
            {accountItems.map((a) => (
              <option key={a.id} value={a.id}>
                {a.number ? `${a.number} — ${a.name}` : a.name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {report.isLoading ? <Spinner label="Loading general ledger" /> : null}
      {report.error ? <ErrorNote error={report.error} /> : null}
      {accounts.error ? <ErrorNote error={accounts.error} /> : null}

      {data ? (
        data.accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No activity between {formatDate(data.startDate)} and {formatDate(data.endDate)}.
          </p>
        ) : (
          <div className="space-y-6">
            {data.accounts.map((account) => (
              <Card key={account.accountId}>
                <CardHeader className="flex-row flex-wrap items-baseline justify-between gap-2 space-y-0">
                  <CardTitle>
                    {account.number ? `${account.number} ${account.name}` : account.name}
                  </CardTitle>
                  <p className="text-sm text-muted-foreground">
                    Opening balance:{' '}
                    <span data-money className="font-mono tabular-nums">
                      {formatMoney(account.openingBalance, currency)}
                    </span>
                  </p>
                </CardHeader>
                <CardContent>
                  {account.rows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No activity in this range.</p>
                  ) : (
                    <Table>
                      <THead>
                        <TR>
                          <TH className="w-28">Date</TH>
                          <TH className="w-28">Entry #</TH>
                          <TH className="w-32">Source</TH>
                          <TH>Memo</TH>
                          <TH className="w-32 text-right">Debit</TH>
                          <TH className="w-32 text-right">Credit</TH>
                          <TH className="w-36 text-right">Balance</TH>
                        </TR>
                      </THead>
                      <TBody>
                        {account.rows.map((row) => (
                          <TR key={row.lineId}>
                            <TD>{formatDate(row.postingDate)}</TD>
                            <TD>{row.entryNumber}</TD>
                            <TD className="text-muted-foreground">{row.sourceType}</TD>
                            <TD className="text-muted-foreground">{row.memo ?? ''}</TD>
                            <TDMoney>{row.debit ? formatMoney(row.debit, currency) : ''}</TDMoney>
                            <TDMoney>{row.credit ? formatMoney(row.credit, currency) : ''}</TDMoney>
                            <TDMoney>{formatMoney(row.runningBalance, currency)}</TDMoney>
                          </TR>
                        ))}
                      </TBody>
                      <TFoot>
                        <TR>
                          <TD colSpan={6}>Ending balance</TD>
                          <TDMoney>{formatMoney(account.endingBalance, currency)}</TDMoney>
                        </TR>
                      </TFoot>
                    </Table>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}
