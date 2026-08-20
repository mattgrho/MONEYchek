import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import type { Me } from '@/lib/types';
import { can } from '@/lib/types';
import { formatDate, formatMoney, todayISO } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input, MoneyInput, Textarea } from '@/components/ui/input';
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

type PostingStatus = 'draft' | 'posted' | 'voided' | 'reversed';

interface BillPaymentAllocation {
  billId: string;
  billNumber: string;
  amount: string;
}

interface BillPaymentListItem {
  id: string;
  number: string;
  vendorId: string;
  vendorName: string;
  postingStatus: PostingStatus;
  paymentDate: string;
  method: string | null;
  reference: string | null;
  amount: string;
  allocations: BillPaymentAllocation[];
}

interface Vendor {
  id: string;
  displayName: string;
  active: boolean;
}

interface Account {
  id: string;
  number: string | null;
  name: string;
  category: string;
  detailType: string | null;
  systemKey: string | null;
  bankKind: 'bank' | 'credit_card' | null;
  active: boolean;
}

interface BillListItem {
  id: string;
  number: string;
  vendorId: string;
  vendorName: string;
  postingStatus: PostingStatus;
  approvalStatus: 'not_required' | 'pending' | 'approved' | 'rejected';
  billDate: string;
  dueDate: string | null;
  vendorReference: string | null;
  total: string;
  openBalance: string;
  settlementStatus: null | 'open' | 'partially_paid' | 'paid';
}

interface ApAgingRow {
  vendorId: string;
  vendorName: string;
  current: string;
  d1_30: string;
  d31_60: string;
  d61_90: string;
  d90_plus: string;
  credits: string;
  total: string;
}

interface ApAgingReport {
  rows: ApAgingRow[];
  total: string;
  controlBalance: string;
  tiesToControl: boolean;
}

const STATUS_TONES: Record<PostingStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  draft: 'neutral',
  posted: 'success',
  voided: 'danger',
  reversed: 'warning',
};

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

const PRICE_PATTERN = /^\d*(\.\d{0,2})?$/;

/** Renders ApiError code + message verbatim so server error codes stay visible. */
function ApiErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const message =
    error instanceof ApiError
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : 'Something went wrong';
  return (
    <div
      role="alert"
      className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {message}
    </div>
  );
}

interface AllocRow {
  checked: boolean;
  amount: string;
}

export function BillPaymentsPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const currency = me.company?.homeCurrency ?? 'USD';
  const canPay = can(me, 'bill_payments.pay');
  const canViewReports = can(me, 'reports.view');

  const [expandedId, setExpandedId] = useState<string | null>(null);

  // ----- pay-bills dialog state -----
  const [formOpen, setFormOpen] = useState(false);
  const [vendorId, setVendorId] = useState('');
  const [paymentDate, setPaymentDate] = useState(todayISO());
  const [bankAccountId, setBankAccountId] = useState('');
  const [method, setMethod] = useState('');
  const [reference, setReference] = useState('');
  const [memo, setMemo] = useState('');
  const [allocs, setAllocs] = useState<Record<string, AllocRow>>({});

  const payments = useQuery({
    queryKey: ['bill-payments'],
    queryFn: () => api.get<{ items: BillPaymentListItem[] }>('/api/v1/bill-payments'),
  });
  const apAging = useQuery({
    queryKey: ['ap-aging'],
    queryFn: () => api.get<ApAgingReport>('/api/v1/reports/ap-aging'),
    enabled: canViewReports,
  });
  const vendorsQuery = useQuery({
    queryKey: ['vendors'],
    queryFn: () => api.get<{ items: Vendor[] }>('/api/v1/vendors'),
    enabled: canPay,
  });
  const accounts = useQuery({
    queryKey: ['accounts', 'for-bill-payments'],
    queryFn: () => api.get<{ items: Account[] }>('/api/v1/accounts'),
    enabled: canPay,
  });
  const bills = useQuery({
    queryKey: ['bills'],
    queryFn: () => api.get<{ items: BillListItem[] }>('/api/v1/bills'),
    enabled: canPay && formOpen,
  });

  const vendorOptions = (vendorsQuery.data?.items ?? []).filter((v) => v.active);
  const bankAccountOptions = (accounts.data?.items ?? []).filter(
    (a) => a.active && a.bankKind === 'bank',
  );
  const openBills =
    vendorId === ''
      ? []
      : (bills.data?.items ?? []).filter(
          (b) =>
            b.vendorId === vendorId && b.postingStatus === 'posted' && toCents(b.openBalance) > 0n,
        );

  // ----- allocation math (exact decimal string math) -----
  const checkedRows = openBills
    .map((bill) => ({ bill, row: allocs[bill.id] }))
    .filter((r): r is { bill: BillListItem; row: AllocRow } => r.row?.checked === true);
  const totalCents = checkedRows.reduce((sum, r) => sum + toCents(r.row.amount), 0n);
  const allocationsValid = checkedRows.every((r) => {
    const c = toCents(r.row.amount);
    return c > 0n && c <= toCents(r.bill.openBalance);
  });

  const canSave =
    vendorId !== '' &&
    paymentDate !== '' &&
    bankAccountId !== '' &&
    checkedRows.length > 0 &&
    allocationsValid;

  function resetForm() {
    setVendorId('');
    setPaymentDate(todayISO());
    setBankAccountId('');
    setMethod('');
    setReference('');
    setMemo('');
    setAllocs({});
  }

  function toggleAllocation(bill: BillListItem, checked: boolean) {
    setAllocs((prev) => ({
      ...prev,
      [bill.id]: checked
        ? { checked: true, amount: centsToDecimalString(toCents(bill.openBalance)) }
        : { checked: false, amount: prev[bill.id]?.amount ?? '' },
    }));
  }

  function setAllocationAmount(billId: string, raw: string) {
    if (!PRICE_PATTERN.test(raw)) return;
    setAllocs((prev) => ({
      ...prev,
      [billId]: { checked: prev[billId]?.checked ?? true, amount: raw },
    }));
  }

  const payBills = useMutation({
    mutationFn: () => {
      const payload: {
        vendorId: string;
        paymentDate: string;
        bankAccountId: string;
        method?: string;
        reference?: string;
        memo?: string;
        allocations: { billId: string; amount: string }[];
        idempotencyKey: string;
      } = {
        vendorId,
        paymentDate,
        bankAccountId,
        allocations: checkedRows.map((r) => ({
          billId: r.bill.id,
          amount: centsToDecimalString(toCents(r.row.amount)),
        })),
        idempotencyKey: crypto.randomUUID(),
      };
      if (method.trim() !== '') payload.method = method.trim();
      if (reference.trim() !== '') payload.reference = reference.trim();
      if (memo.trim() !== '') payload.memo = memo.trim();
      return api.post<{ id: string; number: string; amount: string }>(
        '/api/v1/bill-payments',
        payload,
      );
    },
    onSuccess: (data) => {
      toast('success', `Bill payment ${data.number} recorded`);
      void qc.invalidateQueries({ queryKey: ['bill-payments'] });
      void qc.invalidateQueries({ queryKey: ['bills'] });
      void qc.invalidateQueries({ queryKey: ['bill'] });
      void qc.invalidateQueries({ queryKey: ['ap-aging'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      setFormOpen(false);
      resetForm();
    },
  });

  if (payments.isLoading) return <Spinner label="Loading bill payments" />;
  if (payments.error) return <ErrorNote error={payments.error} />;

  const items = payments.data?.items ?? [];
  const aging = apAging.data;

  // Column sums for the aging footer (exact decimal string math).
  const agingRows = aging?.rows ?? [];
  const sumCents = (pick: (r: ApAgingRow) => string) =>
    agingRows.reduce((sum, r) => sum + toCents(pick(r)), 0n);

  return (
    <div>
      <PageHeader
        title="Bill payments"
        description="Money paid to vendors against posted bills. Each payment settles one vendor's open bills from a bank account."
        actions={
          canPay ? (
            <Button
              onClick={() => {
                payBills.reset();
                resetForm();
                setFormOpen(true);
              }}
            >
              Pay bills
            </Button>
          ) : undefined
        }
      />

      {canViewReports ? (
        <Card className="mb-5">
          <CardHeader className="flex-row flex-wrap items-center justify-between space-y-0 gap-2">
            <div>
              <CardTitle>AP aging</CardTitle>
              <CardDescription>
                Open vendor balances by age as of today, net of unapplied credits.
              </CardDescription>
            </div>
            {aging?.tiesToControl ? <Badge tone="success">Ties to Accounts Payable</Badge> : null}
          </CardHeader>
          <CardContent>
            {apAging.isLoading ? (
              <Spinner label="Loading AP aging" />
            ) : apAging.error ? (
              <ErrorNote error={apAging.error} />
            ) : agingRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No open vendor balances. Nothing is owed right now.
              </p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Vendor</TH>
                    <TH className="text-right">Current</TH>
                    <TH className="text-right">1–30</TH>
                    <TH className="text-right">31–60</TH>
                    <TH className="text-right">61–90</TH>
                    <TH className="text-right">90+</TH>
                    <TH className="text-right">Credits</TH>
                    <TH className="text-right">Total</TH>
                  </TR>
                </THead>
                <TBody>
                  {agingRows.map((r) => (
                    <TR key={r.vendorId}>
                      <TD>{r.vendorName}</TD>
                      <TDMoney>{formatMoney(r.current, currency)}</TDMoney>
                      <TDMoney>{formatMoney(r.d1_30, currency)}</TDMoney>
                      <TDMoney>{formatMoney(r.d31_60, currency)}</TDMoney>
                      <TDMoney>{formatMoney(r.d61_90, currency)}</TDMoney>
                      <TDMoney>{formatMoney(r.d90_plus, currency)}</TDMoney>
                      <TDMoney>{formatMoney(r.credits, currency)}</TDMoney>
                      <TDMoney className="font-semibold">{formatMoney(r.total, currency)}</TDMoney>
                    </TR>
                  ))}
                </TBody>
                <TFoot>
                  <TR>
                    <TD className="text-xs uppercase tracking-wide text-muted-foreground">Total</TD>
                    <TDMoney>
                      {formatMoney(centsToDecimalString(sumCents((r) => r.current)), currency)}
                    </TDMoney>
                    <TDMoney>
                      {formatMoney(centsToDecimalString(sumCents((r) => r.d1_30)), currency)}
                    </TDMoney>
                    <TDMoney>
                      {formatMoney(centsToDecimalString(sumCents((r) => r.d31_60)), currency)}
                    </TDMoney>
                    <TDMoney>
                      {formatMoney(centsToDecimalString(sumCents((r) => r.d61_90)), currency)}
                    </TDMoney>
                    <TDMoney>
                      {formatMoney(centsToDecimalString(sumCents((r) => r.d90_plus)), currency)}
                    </TDMoney>
                    <TDMoney>
                      {formatMoney(centsToDecimalString(sumCents((r) => r.credits)), currency)}
                    </TDMoney>
                    <TDMoney className="font-semibold">
                      {formatMoney(aging?.total, currency)}
                    </TDMoney>
                  </TR>
                </TFoot>
              </Table>
            )}
          </CardContent>
        </Card>
      ) : null}

      {items.length === 0 ? (
        <EmptyState
          title="No bill payments yet"
          description="Pay posted bills to settle what you owe vendors."
          action={
            canPay ? (
              <Button
                onClick={() => {
                  payBills.reset();
                  resetForm();
                  setFormOpen(true);
                }}
              >
                Pay bills
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH className="w-8">
                <span className="sr-only">Expand</span>
              </TH>
              <TH>Number</TH>
              <TH>Vendor</TH>
              <TH>Date</TH>
              <TH>Method / reference</TH>
              <TH className="text-right">Amount</TH>
              <TH>Status</TH>
            </TR>
          </THead>
          <TBody>
            {items.map((p) => {
              const isExpanded = expandedId === p.id;
              return (
                <BillPaymentRowGroup key={p.id}>
                  <TR>
                    <TD>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        aria-expanded={isExpanded}
                        aria-label={
                          isExpanded
                            ? `Collapse payment ${p.number}`
                            : `Expand payment ${p.number} to see bill allocations`
                        }
                        onClick={() => setExpandedId(isExpanded ? null : p.id)}
                      >
                        {isExpanded ? (
                          <ChevronDown className="h-4 w-4" aria-hidden />
                        ) : (
                          <ChevronRight className="h-4 w-4" aria-hidden />
                        )}
                      </Button>
                    </TD>
                    <TD className="font-mono text-[13px] font-medium">{p.number}</TD>
                    <TD>{p.vendorName}</TD>
                    <TD className="text-muted-foreground">{formatDate(p.paymentDate)}</TD>
                    <TD className="text-muted-foreground">
                      {p.method ?? '—'}
                      {p.reference ? ` · ${p.reference}` : ''}
                    </TD>
                    <TDMoney>{formatMoney(p.amount, currency)}</TDMoney>
                    <TD>
                      <Badge tone={STATUS_TONES[p.postingStatus]}>{p.postingStatus}</Badge>
                    </TD>
                  </TR>
                  {isExpanded ? (
                    <TR className="bg-muted/30 hover:bg-muted/30">
                      <TD colSpan={7} className="p-4">
                        <div className="space-y-3">
                          <h4 className="text-sm font-semibold">Bill allocations</h4>
                          {p.allocations.length === 0 ? (
                            <p className="text-sm text-muted-foreground">
                              This payment has no bill allocations.
                            </p>
                          ) : (
                            <Table>
                              <THead>
                                <TR>
                                  <TH>Bill</TH>
                                  <TH className="text-right">Amount</TH>
                                </TR>
                              </THead>
                              <TBody>
                                {p.allocations.map((a) => (
                                  <TR key={a.billId}>
                                    <TD className="font-mono text-[13px]">{a.billNumber}</TD>
                                    <TDMoney>{formatMoney(a.amount, currency)}</TDMoney>
                                  </TR>
                                ))}
                              </TBody>
                            </Table>
                          )}
                        </div>
                      </TD>
                    </TR>
                  ) : null}
                </BillPaymentRowGroup>
              );
            })}
          </TBody>
        </Table>
      )}

      {/* ----- pay bills dialog ----- */}
      <Dialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) resetForm();
        }}
        title="Pay bills"
        description="Pays a vendor's posted open bills from a bank account. The payment posts to the ledger immediately."
        wide
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            payBills.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="bp-vendor">Vendor</Label>
              <Select
                id="bp-vendor"
                required
                value={vendorId}
                onChange={(e) => {
                  setVendorId(e.target.value);
                  setAllocs({});
                }}
              >
                <option value="" disabled>
                  Select a vendor…
                </option>
                {vendorOptions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.displayName}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bp-date">Payment date</Label>
              <Input
                id="bp-date"
                type="date"
                required
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bp-bank">Pay from bank account</Label>
              <Select
                id="bp-bank"
                required
                value={bankAccountId}
                onChange={(e) => setBankAccountId(e.target.value)}
              >
                <option value="" disabled>
                  Select a bank account…
                </option>
                {bankAccountOptions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.number ? `${a.number} · ${a.name}` : a.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="bp-method">Method (optional)</Label>
              <Select id="bp-method" value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="">No method</option>
                <option value="check">Check</option>
                <option value="ach">ACH</option>
                <option value="card">Card</option>
                <option value="cash">Cash</option>
                <option value="wire">Wire</option>
                <option value="other">Other</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bp-reference">Reference (optional)</Label>
              <Input
                id="bp-reference"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bp-memo">Memo (optional)</Label>
              <Textarea
                id="bp-memo"
                className="min-h-[36px]"
                rows={1}
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
              />
            </div>
          </div>

          {vendorId === '' ? (
            <p className="text-sm text-muted-foreground">
              Select a vendor to see their posted open bills.
            </p>
          ) : bills.isLoading ? (
            <Spinner label="Loading open bills" />
          ) : bills.error ? (
            <ErrorNote error={bills.error} />
          ) : openBills.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This vendor has no posted open bills to pay.
            </p>
          ) : (
            <>
              <Table>
                <THead>
                  <TR>
                    <TH className="w-12">Pay</TH>
                    <TH>Bill</TH>
                    <TH>Due date</TH>
                    <TH className="text-right">Open balance</TH>
                    <TH className="w-32 text-right">Payment</TH>
                  </TR>
                </THead>
                <TBody>
                  {openBills.map((bill) => {
                    const row = allocs[bill.id];
                    const checked = row?.checked === true;
                    const rowCents = row ? toCents(row.amount) : 0n;
                    const overOpen = checked && rowCents > toCents(bill.openBalance);
                    return (
                      <TR key={bill.id}>
                        <TD className="text-center">
                          <input
                            type="checkbox"
                            aria-label={`Pay bill ${bill.number}`}
                            className="h-4 w-4 rounded border-input"
                            checked={checked}
                            onChange={(e) => toggleAllocation(bill, e.target.checked)}
                          />
                        </TD>
                        <TD className="font-mono text-[13px]">{bill.number}</TD>
                        <TD className="text-muted-foreground">{formatDate(bill.dueDate)}</TD>
                        <TDMoney>{formatMoney(bill.openBalance, currency)}</TDMoney>
                        <TD>
                          <MoneyInput
                            aria-label={`Amount to pay on bill ${bill.number}`}
                            placeholder="0.00"
                            disabled={!checked}
                            value={checked ? (row?.amount ?? '') : ''}
                            onChange={(e) => setAllocationAmount(bill.id, e.target.value)}
                            className={overOpen ? 'border-destructive' : undefined}
                          />
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
              <div className="flex items-center justify-end text-sm">
                <span className="text-muted-foreground">
                  Total payment:{' '}
                  <span data-money className="font-mono tabular-nums font-semibold text-foreground">
                    {formatMoney(centsToDecimalString(totalCents), currency)}
                  </span>
                </span>
              </div>
            </>
          )}

          {payBills.error ? <ApiErrorNote error={payBills.error} /> : null}

          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {!canSave
                ? !allocationsValid
                  ? 'Each payment amount must be greater than zero and no more than the bill open balance.'
                  : 'A vendor, date, bank account, and at least one bill to pay are required.'
                : 'Ready to pay.'}
            </p>
            <Button type="submit" disabled={!canSave} loading={payBills.isPending}>
              Pay bills
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

/** Groups a payment row with its optional expanded-details row. */
function BillPaymentRowGroup({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
