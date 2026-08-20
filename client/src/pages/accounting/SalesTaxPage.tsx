import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Me } from '@/lib/types';
import { can } from '@/lib/types';
import { formatDate, formatMoney, todayISO } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input, MoneyInput } from '@/components/ui/input';
import { Dialog } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorNote,
  Label,
  PageHeader,
  Select,
  Spinner,
} from '@/components/ui/primitives';
import { Table, TBody, TD, TDMoney, TFoot, TH, THead, TR } from '@/components/ui/table';

interface AgencyRow {
  agencyName: string;
  taxableSales: string;
  taxCollected: string;
}

interface LiabilityReport {
  startDate: string;
  endDate: string;
  agencies: AgencyRow[];
  totalCollected: string;
  remittedInPeriod: string;
  ledgerBalanceAsOf: string;
}

interface TaxPayment {
  journalEntryId: string;
  entryNumber: string;
  paymentDate: string;
  amount: string;
  memo: string | null;
}

interface TaxRate {
  id: string;
  name: string;
  agencyName: string | null;
  /** Fraction string, e.g. '0.06000000'. */
  rate: string;
  active: boolean;
}

interface Account {
  id: string;
  name: string;
  active: boolean;
  systemKey: string | null;
  bankKind: string | null;
}

const PRICE_PATTERN = /^\d*(\.\d{0,2})?$/;
const PERCENT_PATTERN = /^\d{0,2}(\.\d{0,4})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** '0.06250000' -> '6.25' with exact string math (shift by 2). */
function fractionToPercent(fraction: string): string {
  const [intPart = '0', decPart = ''] = fraction.split('.');
  const digits = intPart.replace('-', '') + decPart.padEnd(2, '0');
  const shifted = `${digits.slice(0, intPart.length + 2)}.${digits.slice(intPart.length + 2)}`;
  const trimmed = shifted.replace(/^0+(?=\d)/, '').replace(/\.?0+$/, '');
  return trimmed === '' || trimmed === '.' ? '0' : trimmed;
}

function firstOfYear(today: string): string {
  return `${today.slice(0, 4)}-01-01`;
}

export function SalesTaxPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const currency = me.company?.homeCurrency ?? 'USD';
  const canPay = can(me, 'journals.post');
  const canEditRates = can(me, 'company.edit');
  const today = todayISO();

  const [startDate, setStartDate] = useState(firstOfYear(today));
  const [endDate, setEndDate] = useState(today);
  const rangeValid = DATE_RE.test(startDate) && DATE_RE.test(endDate) && startDate <= endDate;

  const report = useQuery({
    queryKey: ['sales-tax-liability', startDate, endDate],
    queryFn: () =>
      api.get<LiabilityReport>(
        `/api/v1/sales-tax/liability?startDate=${startDate}&endDate=${endDate}`,
      ),
    enabled: rangeValid,
  });
  const payments = useQuery({
    queryKey: ['sales-tax-payments'],
    queryFn: () => api.get<{ items: TaxPayment[] }>('/api/v1/sales-tax/payments'),
  });
  const rates = useQuery({
    queryKey: ['tax-rates'],
    queryFn: () => api.get<{ items: TaxRate[] }>('/api/v1/tax-rates'),
  });
  const accounts = useQuery({
    queryKey: ['accounts', { withBalances: true }],
    queryFn: () => api.get<{ items: Account[] }>('/api/v1/accounts?withBalances=true'),
    enabled: canPay,
  });
  const bankOptions = (accounts.data?.items ?? []).filter((a) => a.active && a.bankKind === 'bank');

  // ----- record payment dialog -----
  const [payOpen, setPayOpen] = useState(false);
  const [payDate, setPayDate] = useState(today);
  const [payAmount, setPayAmount] = useState('');
  const [payBankId, setPayBankId] = useState('');
  const [payAgency, setPayAgency] = useState('');

  const recordPayment = useMutation({
    mutationFn: () =>
      api.post<{ journalEntryId: string }>('/api/v1/sales-tax/payments', {
        paymentDate: payDate,
        amount: payAmount.trim(),
        bankAccountId: payBankId,
        agencyName: payAgency.trim() !== '' ? payAgency.trim() : undefined,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: () => {
      toast('success', 'Tax payment recorded');
      setPayOpen(false);
      setPayAmount('');
      setPayAgency('');
      void qc.invalidateQueries({ queryKey: ['sales-tax-payments'] });
      void qc.invalidateQueries({ queryKey: ['sales-tax-liability'] });
    },
  });
  const canSubmitPayment =
    DATE_RE.test(payDate) &&
    payAmount.trim() !== '' &&
    PRICE_PATTERN.test(payAmount) &&
    payBankId !== '';

  // ----- rate dialogs -----
  const [rateOpen, setRateOpen] = useState(false);
  const [editingRate, setEditingRate] = useState<TaxRate | null>(null);
  const [rateName, setRateName] = useState('');
  const [rateAgency, setRateAgency] = useState('');
  const [ratePercent, setRatePercent] = useState('');
  const [rateActive, setRateActive] = useState(true);

  function openRateDialog(rate: TaxRate | null) {
    setEditingRate(rate);
    setRateName(rate?.name ?? '');
    setRateAgency(rate?.agencyName ?? '');
    setRatePercent(rate ? fractionToPercent(rate.rate) : '');
    setRateActive(rate?.active ?? true);
    setRateOpen(true);
  }

  const saveRate = useMutation({
    mutationFn: () => {
      const payload = {
        name: rateName.trim(),
        agencyName: rateAgency.trim(),
        ratePercent: ratePercent.trim(),
        active: rateActive,
      };
      return editingRate
        ? api.patch<TaxRate>(`/api/v1/tax-rates/${editingRate.id}`, payload)
        : api.post<TaxRate>('/api/v1/tax-rates', payload);
    },
    onSuccess: () => {
      toast('success', editingRate ? 'Tax rate updated' : 'Tax rate created');
      setRateOpen(false);
      void qc.invalidateQueries({ queryKey: ['tax-rates'] });
      void qc.invalidateQueries({ queryKey: ['sales-tax-liability'] });
    },
  });
  const canSaveRate =
    rateName.trim() !== '' &&
    ratePercent.trim() !== '' &&
    PERCENT_PATTERN.test(ratePercent) &&
    ratePercent.trim() !== '.';

  return (
    <div>
      <PageHeader
        title="Sales tax"
        description="Manual single-rate sales tax: collections by agency from posted documents, remittances against the Sales Tax Payable liability, and rate management."
        actions={
          canPay ? (
            <Button
              onClick={() => {
                recordPayment.reset();
                setPayDate(today);
                setPayOpen(true);
              }}
            >
              Record tax payment
            </Button>
          ) : undefined
        }
      />

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Liability by agency</CardTitle>
          <CardDescription>
            Collections come from posted invoices, sales receipts, and credit memos in the period.
            The ledger balance is the Sales Tax Payable control account as of the end date —
            everything collected and not yet remitted, across all time.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="tax-start">From</Label>
              <Input
                id="tax-start"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-44"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tax-end">To</Label>
              <Input
                id="tax-end"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-44"
              />
            </div>
            {!rangeValid ? (
              <p className="pb-2 text-xs text-destructive">Enter a valid date range.</p>
            ) : null}
          </div>
          {report.isLoading ? (
            <Spinner label="Computing liability" />
          ) : report.error ? (
            <ErrorNote error={report.error} />
          ) : report.data ? (
            <>
              {report.data.agencies.length === 0 ? (
                <EmptyState
                  title="No tax collected in this period"
                  description="Post an invoice or sales receipt with a tax rate to see collections here."
                />
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Agency</TH>
                      <TH className="text-right">Taxable sales</TH>
                      <TH className="text-right">Tax collected</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {report.data.agencies.map((a) => (
                      <TR key={a.agencyName}>
                        <TD className="font-medium">{a.agencyName}</TD>
                        <TDMoney>{formatMoney(a.taxableSales, currency)}</TDMoney>
                        <TDMoney>{formatMoney(a.taxCollected, currency)}</TDMoney>
                      </TR>
                    ))}
                  </TBody>
                  <TFoot>
                    <TR>
                      <TD className="text-right text-xs uppercase tracking-wide text-muted-foreground">
                        Total collected in period
                      </TD>
                      <TD />
                      <TDMoney>{formatMoney(report.data.totalCollected, currency)}</TDMoney>
                    </TR>
                  </TFoot>
                </Table>
              )}
              <div className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
                <p className="text-muted-foreground">
                  Remitted in period:{' '}
                  <span className="font-medium text-foreground">
                    {formatMoney(report.data.remittedInPeriod, currency)}
                  </span>
                </p>
                <p className="text-muted-foreground">
                  Sales Tax Payable as of {formatDate(report.data.endDate)}:{' '}
                  <span className="font-medium text-foreground">
                    {formatMoney(report.data.ledgerBalanceAsOf, currency)}
                  </span>
                </p>
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Tax payments</CardTitle>
            <CardDescription>
              Remittances post directly against the liability (never through manual journals).
            </CardDescription>
          </CardHeader>
          <CardContent>
            {payments.data && payments.data.items.length === 0 ? (
              <EmptyState
                title="No tax payments yet"
                description="Record a payment when you remit collected tax to an agency."
              />
            ) : payments.data ? (
              <Table>
                <THead>
                  <TR>
                    <TH>Date</TH>
                    <TH>Memo</TH>
                    <TH className="text-right">Amount</TH>
                  </TR>
                </THead>
                <TBody>
                  {payments.data.items.map((p) => (
                    <TR key={p.journalEntryId}>
                      <TD className="text-muted-foreground">{formatDate(p.paymentDate)}</TD>
                      <TD>{p.memo ?? '—'}</TD>
                      <TDMoney>{formatMoney(p.amount, currency)}</TDMoney>
                    </TR>
                  ))}
                </TBody>
              </Table>
            ) : payments.error ? (
              <ErrorNote error={payments.error} />
            ) : (
              <Spinner label="Loading payments" />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              Tax rates
              {canEditRates ? (
                <Button size="sm" variant="outline" onClick={() => openRateDialog(null)}>
                  New rate
                </Button>
              ) : null}
            </CardTitle>
            <CardDescription>
              One combined rate per document. Posted documents keep their frozen tax snapshot; a
              rate change only affects future documents.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {rates.data && rates.data.items.length === 0 ? (
              <EmptyState
                title="No tax rates yet"
                description="Create a rate to charge tax on invoices and sales receipts."
              />
            ) : rates.data ? (
              <Table>
                <THead>
                  <TR>
                    <TH>Name</TH>
                    <TH>Agency</TH>
                    <TH className="text-right">Rate</TH>
                    <TH>Status</TH>
                    {canEditRates ? <TH className="w-20">Actions</TH> : null}
                  </TR>
                </THead>
                <TBody>
                  {rates.data.items.map((r) => (
                    <TR key={r.id}>
                      <TD className="font-medium">{r.name}</TD>
                      <TD className="text-muted-foreground">{r.agencyName || '—'}</TD>
                      <TD className="text-right font-mono text-[13px]">
                        {fractionToPercent(r.rate)}%
                      </TD>
                      <TD>
                        {r.active ? (
                          <Badge tone="success">Active</Badge>
                        ) : (
                          <Badge tone="neutral">Inactive</Badge>
                        )}
                      </TD>
                      {canEditRates ? (
                        <TD>
                          <Button variant="ghost" size="sm" onClick={() => openRateDialog(r)}>
                            Edit
                          </Button>
                        </TD>
                      ) : null}
                    </TR>
                  ))}
                </TBody>
              </Table>
            ) : rates.error ? (
              <ErrorNote error={rates.error} />
            ) : (
              <Spinner label="Loading rates" />
            )}
          </CardContent>
        </Card>
      </div>

      {/* ----- record payment dialog ----- */}
      <Dialog
        open={payOpen}
        onOpenChange={(next) => {
          setPayOpen(next);
          if (!next) recordPayment.reset();
        }}
        title="Record tax payment"
        description="Debits Sales Tax Payable and credits the bank account you paid from."
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            recordPayment.mutate();
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="pay-date">Payment date</Label>
              <Input
                id="pay-date"
                type="date"
                required
                value={payDate}
                onChange={(e) => setPayDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pay-amount">Amount</Label>
              <MoneyInput
                id="pay-amount"
                required
                placeholder="0.00"
                value={payAmount}
                onChange={(e) => {
                  if (PRICE_PATTERN.test(e.target.value)) setPayAmount(e.target.value);
                }}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pay-bank">Bank account</Label>
            <Select
              id="pay-bank"
              required
              value={payBankId}
              onChange={(e) => setPayBankId(e.target.value)}
            >
              <option value="" disabled>
                Select a bank account…
              </option>
              {bankOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pay-agency">Agency (optional, shown in the memo)</Label>
            <Input
              id="pay-agency"
              value={payAgency}
              onChange={(e) => setPayAgency(e.target.value)}
              placeholder="e.g. State Department of Revenue"
            />
          </div>
          {recordPayment.error ? <ErrorNote error={recordPayment.error} /> : null}
          <div className="flex justify-end">
            <Button type="submit" disabled={!canSubmitPayment} loading={recordPayment.isPending}>
              Record payment
            </Button>
          </div>
        </form>
      </Dialog>

      {/* ----- rate dialog ----- */}
      <Dialog
        open={rateOpen}
        onOpenChange={(next) => {
          setRateOpen(next);
          if (!next) saveRate.reset();
        }}
        title={editingRate ? 'Edit tax rate' : 'New tax rate'}
        description={
          editingRate
            ? 'Posted documents keep their frozen tax; changes apply to future documents only.'
            : 'A combined percentage applied to taxable lines on sales documents.'
        }
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            saveRate.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="rate-name">Name</Label>
            <Input
              id="rate-name"
              required
              value={rateName}
              onChange={(e) => setRateName(e.target.value)}
              placeholder="e.g. State Sales Tax"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="rate-agency">Agency</Label>
              <Input
                id="rate-agency"
                value={rateAgency}
                onChange={(e) => setRateAgency(e.target.value)}
                placeholder="Who you remit to"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rate-percent">Rate (%)</Label>
              <MoneyInput
                id="rate-percent"
                required
                placeholder="8.25"
                value={ratePercent}
                onChange={(e) => {
                  if (PERCENT_PATTERN.test(e.target.value)) setRatePercent(e.target.value);
                }}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-input"
              checked={rateActive}
              onChange={(e) => setRateActive(e.target.checked)}
            />
            Active (available on new documents)
          </label>
          {saveRate.error ? <ErrorNote error={saveRate.error} /> : null}
          <div className="flex justify-end">
            <Button type="submit" disabled={!canSaveRate} loading={saveRate.isPending}>
              {editingRate ? 'Save changes' : 'Create rate'}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
