import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Me } from '@/lib/types';
import { formatDate, formatMoney, todayISO } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { ErrorNote, Label, PageHeader, Spinner } from '@/components/ui/primitives';
import { Table, TBody, TD, TDMoney, TH, THead, TR } from '@/components/ui/table';

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
interface ProfitLossReport {
  startDate: string;
  endDate: string;
  income: Section;
  cogs: Section;
  grossProfit: string;
  expenses: Section;
  otherIncome: Section;
  otherExpenses: Section;
  netIncome: string;
}

function SectionRows({ section, currency }: { section: Section; currency: string }) {
  return (
    <Fragment>
      <TR className="bg-muted/30">
        <TD colSpan={2} className="font-semibold">
          {section.label}
        </TD>
        <TD />
      </TR>
      {section.rows.map((row) => (
        <TR key={row.accountId}>
          <TD className="w-28 text-muted-foreground">{row.number ?? '—'}</TD>
          <TD className="pl-6">{row.name}</TD>
          <TDMoney>{formatMoney(row.amount, currency)}</TDMoney>
        </TR>
      ))}
      <TR>
        <TD />
        <TD className="font-medium">Total {section.label.toLowerCase()}</TD>
        <TDMoney className="font-medium">{formatMoney(section.total, currency)}</TDMoney>
      </TR>
    </Fragment>
  );
}

export function ProfitLossPage({ me }: { me: Me }) {
  const currency = me.company?.homeCurrency ?? 'USD';
  const [startDate, setStartDate] = useState(`${new Date().getFullYear()}-01-01`);
  const [endDate, setEndDate] = useState(todayISO());

  const report = useQuery({
    queryKey: ['profit-and-loss', startDate, endDate],
    queryFn: () =>
      api.get<ProfitLossReport>(
        `/api/v1/reports/profit-and-loss?startDate=${encodeURIComponent(
          startDate,
        )}&endDate=${encodeURIComponent(endDate)}`,
      ),
    enabled: startDate.length > 0 && endDate.length > 0,
  });

  const data = report.data;

  return (
    <div>
      <Link to="/reports" className="mb-3 inline-block text-sm text-primary underline">
        &larr; All reports
      </Link>
      <PageHeader
        title="Profit & loss"
        description={`Activity from ${formatDate(startDate)} to ${formatDate(endDate)}.`}
      />

      <div className="mb-5 flex flex-wrap items-end gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="pl-start">Start date</Label>
          <Input
            id="pl-start"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="w-44"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pl-end">End date</Label>
          <Input
            id="pl-end"
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="w-44"
          />
        </div>
      </div>

      {report.isLoading ? <Spinner label="Loading profit & loss" /> : null}
      {report.error ? <ErrorNote error={report.error} /> : null}

      {data ? (
        <Table>
          <THead>
            <TR>
              <TH className="w-28">Number</TH>
              <TH>Account</TH>
              <TH className="w-44 text-right">Amount</TH>
            </TR>
          </THead>
          <TBody>
            <SectionRows section={data.income} currency={currency} />
            {data.cogs.rows.length > 0 ? (
              <SectionRows section={data.cogs} currency={currency} />
            ) : null}
            <TR className="border-t-2">
              <TD />
              <TD className="font-semibold">Gross profit</TD>
              <TDMoney className="font-semibold">{formatMoney(data.grossProfit, currency)}</TDMoney>
            </TR>
            <SectionRows section={data.expenses} currency={currency} />
            {data.otherIncome.rows.length > 0 ? (
              <SectionRows section={data.otherIncome} currency={currency} />
            ) : null}
            {data.otherExpenses.rows.length > 0 ? (
              <SectionRows section={data.otherExpenses} currency={currency} />
            ) : null}
            <TR className="border-t-2 bg-muted/40">
              <TD />
              <TD className="font-bold">Net income</TD>
              <TDMoney className="font-bold">{formatMoney(data.netIncome, currency)}</TDMoney>
            </TR>
          </TBody>
        </Table>
      ) : null}
    </div>
  );
}
