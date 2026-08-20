import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Me } from '@/lib/types';
import { formatDate, formatMoney, todayISO } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Badge, ErrorNote, Label, PageHeader, Spinner } from '@/components/ui/primitives';
import { Table, TBody, TD, TDMoney, TH, THead, TR } from '@/components/ui/table';

interface JournalLine {
  lineNumber: number;
  accountId: string;
  accountNumber: string | null;
  accountName: string;
  debit: string | null;
  credit: string | null;
  memo: string | null;
}
interface JournalEntry {
  entryId: string;
  entryNumber: string;
  postingDate: string;
  sourceType: string;
  memo: string | null;
  reversalOfEntryId: string | null;
  lines: JournalLine[];
}
interface JournalReport {
  items: JournalEntry[];
}

export function JournalReportPage({ me }: { me: Me }) {
  const currency = me.company?.homeCurrency ?? 'USD';
  const [startDate, setStartDate] = useState(`${new Date().getFullYear()}-01-01`);
  const [endDate, setEndDate] = useState(todayISO());

  const report = useQuery({
    queryKey: ['journal-report', startDate, endDate],
    queryFn: () =>
      api.get<JournalReport>(
        `/api/v1/reports/journal?startDate=${encodeURIComponent(
          startDate,
        )}&endDate=${encodeURIComponent(endDate)}`,
      ),
    enabled: startDate.length > 0 && endDate.length > 0,
  });

  const entries = report.data?.items;

  return (
    <div>
      <Link to="/reports" className="mb-3 inline-block text-sm text-primary underline">
        &larr; All reports
      </Link>
      <PageHeader
        title="Journal"
        description={`All journal entries from ${formatDate(startDate)} to ${formatDate(
          endDate,
        )}, in posting order.`}
      />

      <div className="mb-5 flex flex-wrap items-end gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="jr-start">Start date</Label>
          <Input
            id="jr-start"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="w-44"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="jr-end">End date</Label>
          <Input
            id="jr-end"
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="w-44"
          />
        </div>
      </div>

      {report.isLoading ? <Spinner label="Loading journal" /> : null}
      {report.error ? <ErrorNote error={report.error} /> : null}

      {entries ? (
        entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No journal entries between {formatDate(startDate)} and {formatDate(endDate)}.
          </p>
        ) : (
          <div className="space-y-4">
            {entries.map((entry) => (
              <div
                key={entry.entryId}
                className="rounded-lg border border-border bg-card p-4 shadow-sm"
              >
                <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                  <span className="font-medium">{formatDate(entry.postingDate)}</span>
                  <span className="font-mono">{entry.entryNumber}</span>
                  <Badge tone="neutral">{entry.sourceType}</Badge>
                  {entry.reversalOfEntryId ? <Badge tone="warning">Reversal</Badge> : null}
                  {entry.memo ? <span className="text-muted-foreground">{entry.memo}</span> : null}
                </div>
                <Table>
                  <THead>
                    <TR>
                      <TH>Account</TH>
                      <TH className="w-36 text-right">Debit</TH>
                      <TH className="w-36 text-right">Credit</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {entry.lines.map((line) => (
                      <TR key={line.lineNumber}>
                        <TD>
                          <span className="text-muted-foreground">
                            {line.accountNumber ? `${line.accountNumber} ` : ''}
                          </span>
                          {line.accountName}
                          {line.memo ? (
                            <span className="ml-2 text-xs text-muted-foreground">{line.memo}</span>
                          ) : null}
                        </TD>
                        <TDMoney>{line.debit ? formatMoney(line.debit, currency) : ''}</TDMoney>
                        <TDMoney>{line.credit ? formatMoney(line.credit, currency) : ''}</TDMoney>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}
