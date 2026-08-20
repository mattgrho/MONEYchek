import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Me } from '@/lib/types';
import { formatDate, formatMoney, todayISO } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Badge, ErrorNote, Label, PageHeader, Spinner } from '@/components/ui/primitives';
import { Table, TBody, TD, TDMoney, TFoot, TH, THead, TR } from '@/components/ui/table';

interface SectionRow {
  accountId: string;
  number: string | null;
  name: string;
  amount: string;
}
interface Section {
  label: string;
  rows: SectionRow[];
  total: string;
}
interface BalanceSheetReport {
  asOf: string;
  assets: Section;
  liabilities: Section;
  equity: Section & { retainedEarnings: string; currentYearNetIncome: string };
  totalAssets: string;
  totalLiabilitiesAndEquity: string;
  balanced: boolean;
}

function SectionHeading({ label }: { label: string }) {
  return (
    <TR className="bg-muted/30">
      <TD colSpan={2} className="font-semibold">
        {label}
      </TD>
      <TD />
    </TR>
  );
}

function AccountRows({ rows, currency }: { rows: SectionRow[]; currency: string }) {
  return (
    <Fragment>
      {rows.map((row) => (
        <TR key={row.accountId}>
          <TD className="w-28 text-muted-foreground">{row.number ?? '—'}</TD>
          <TD className="pl-6">{row.name}</TD>
          <TDMoney>{formatMoney(row.amount, currency)}</TDMoney>
        </TR>
      ))}
    </Fragment>
  );
}

function TotalRow({
  label,
  amount,
  currency,
}: {
  label: string;
  amount: string;
  currency: string;
}) {
  return (
    <TR>
      <TD />
      <TD className="font-medium">{label}</TD>
      <TDMoney className="font-medium">{formatMoney(amount, currency)}</TDMoney>
    </TR>
  );
}

export function BalanceSheetPage({ me }: { me: Me }) {
  const currency = me.company?.homeCurrency ?? 'USD';
  const [asOf, setAsOf] = useState(todayISO());

  const report = useQuery({
    queryKey: ['balance-sheet', asOf],
    queryFn: () =>
      api.get<BalanceSheetReport>(`/api/v1/reports/balance-sheet?asOf=${encodeURIComponent(asOf)}`),
    enabled: asOf.length > 0,
  });

  const data = report.data;

  return (
    <div>
      <Link to="/reports" className="mb-3 inline-block text-sm text-primary underline">
        &larr; All reports
      </Link>
      <PageHeader
        title="Balance sheet"
        description={`Financial position as of ${formatDate(asOf)}.`}
      />

      <div className="mb-5 flex flex-wrap items-end gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="bs-as-of">As of date</Label>
          <Input
            id="bs-as-of"
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            className="w-44"
          />
        </div>
        {data ? (
          data.balanced ? (
            <Badge tone="success">Balanced</Badge>
          ) : (
            <Badge tone="danger">Not balanced</Badge>
          )
        ) : null}
      </div>

      {report.isLoading ? <Spinner label="Loading balance sheet" /> : null}
      {report.error ? <ErrorNote error={report.error} /> : null}

      {data ? (
        <div className="space-y-4">
          {!data.balanced ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              Warning: total assets do not equal total liabilities and equity as of{' '}
              {formatDate(data.asOf)}. Review recent postings.
            </div>
          ) : null}
          <Table>
            <THead>
              <TR>
                <TH className="w-28">Number</TH>
                <TH>Account</TH>
                <TH className="w-44 text-right">Amount</TH>
              </TR>
            </THead>
            <TBody>
              <SectionHeading label={data.assets.label} />
              <AccountRows rows={data.assets.rows} currency={currency} />
              <TotalRow label="Total assets" amount={data.totalAssets} currency={currency} />

              <SectionHeading label={data.liabilities.label} />
              <AccountRows rows={data.liabilities.rows} currency={currency} />
              <TotalRow
                label={`Total ${data.liabilities.label.toLowerCase()}`}
                amount={data.liabilities.total}
                currency={currency}
              />

              <SectionHeading label={data.equity.label} />
              <AccountRows rows={data.equity.rows} currency={currency} />
              <TR>
                <TD />
                <TD className="pl-6">Retained earnings</TD>
                <TDMoney>{formatMoney(data.equity.retainedEarnings, currency)}</TDMoney>
              </TR>
              <TR>
                <TD />
                <TD className="pl-6">Net income (current year)</TD>
                <TDMoney>{formatMoney(data.equity.currentYearNetIncome, currency)}</TDMoney>
              </TR>
              <TotalRow
                label={`Total ${data.equity.label.toLowerCase()}`}
                amount={data.equity.total}
                currency={currency}
              />
            </TBody>
            <TFoot>
              <TR>
                <TD />
                <TD>Total assets</TD>
                <TDMoney>{formatMoney(data.totalAssets, currency)}</TDMoney>
              </TR>
              <TR>
                <TD />
                <TD>Total liabilities + equity</TD>
                <TDMoney>{formatMoney(data.totalLiabilitiesAndEquity, currency)}</TDMoney>
              </TR>
            </TFoot>
          </Table>
        </div>
      ) : null}
    </div>
  );
}
