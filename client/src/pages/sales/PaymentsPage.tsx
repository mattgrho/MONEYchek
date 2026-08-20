import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { LoadMoreButton, usePagedList } from '@/lib/paging';
import type { Me } from '@/lib/types';
import { can } from '@/lib/types';
import { formatDate, formatMoney, todayISO } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input, MoneyInput, Textarea } from '@/components/ui/input';
import { Dialog } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import {
  Badge,
  EmptyState,
  ErrorNote,
  Label,
  PageHeader,
  Select,
  Spinner,
} from '@/components/ui/primitives';
import { Table, TBody, TD, TDMoney, TH, THead, TR } from '@/components/ui/table';

type PostingStatus = 'draft' | 'posted' | 'voided' | 'reversed';

interface PaymentListItem {
  id: string;
  number: string;
  customerId: string;
  customerName: string;
  postingStatus: PostingStatus;
  paymentDate: string;
  method: string | null;
  reference: string | null;
  amount: string;
  depositToName: string | null;
  unapplied: string;
  returnedDate: string | null;
}

interface PaymentAllocation {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  amount: string;
  effectiveDate: string;
  reversalOfAllocationId: string | null;
}

interface PaymentDetail extends PaymentListItem {
  allocations: PaymentAllocation[];
}

interface Customer {
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
  bankKind: string | null;
  active: boolean;
}

interface InvoiceListItem {
  id: string;
  number: string;
  customerId: string;
  customerName: string;
  postingStatus: PostingStatus;
  invoiceDate: string;
  dueDate: string | null;
  subtotal: string;
  taxTotal: string;
  total: string;
  openBalance: string;
  settlementStatus: null | 'open' | 'partially_paid' | 'paid';
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

export function PaymentsPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const currency = me.company?.homeCurrency ?? 'USD';
  const canCreate = can(me, 'customer_payments.create');
  const canEdit = can(me, 'customer_payments.edit');
  const canVoid = can(me, 'customer_payments.void');

  const [expandedId, setExpandedId] = useState<string | null>(null);

  // ----- receive-payment dialog state -----
  const [formOpen, setFormOpen] = useState(false);
  const [customerId, setCustomerId] = useState('');
  const [paymentDate, setPaymentDate] = useState(todayISO());
  const [amount, setAmount] = useState('');
  const [depositToAccountId, setDepositToAccountId] = useState('');
  const [method, setMethod] = useState('');
  const [reference, setReference] = useState('');
  const [memo, setMemo] = useState('');
  const [autoApply, setAutoApply] = useState(false);
  const [allocs, setAllocs] = useState<Record<string, AllocRow>>({});

  // ----- void dialog state -----
  const [voidTarget, setVoidTarget] = useState<PaymentListItem | null>(null);
  const [voidReason, setVoidReason] = useState('');

  // ----- refund dialog state -----
  const [refundTarget, setRefundTarget] = useState<PaymentListItem | null>(null);
  const [refundAmount, setRefundAmount] = useState('');
  const [refundDate, setRefundDate] = useState(todayISO());
  const [refundBankAccountId, setRefundBankAccountId] = useState('');

  // ----- bank-return dialog state -----
  const [returnTarget, setReturnTarget] = useState<PaymentListItem | null>(null);
  const [returnDate, setReturnDate] = useState(todayISO());
  const [returnReason, setReturnReason] = useState('');

  const payments = usePagedList<PaymentListItem>(['payments'], '/api/v1/payments');
  const customers = useQuery({
    queryKey: ['customers'],
    queryFn: () => api.get<{ items: Customer[] }>('/api/v1/customers'),
    enabled: canCreate,
  });
  const accounts = useQuery({
    queryKey: ['accounts', 'for-payments'],
    queryFn: () => api.get<{ items: Account[] }>('/api/v1/accounts?withBalances=true'),
    enabled: canCreate,
  });
  const customerInvoices = useQuery({
    queryKey: ['invoices', { customerId }],
    queryFn: () =>
      api.get<{ items: InvoiceListItem[] }>(
        `/api/v1/invoices?customerId=${encodeURIComponent(customerId)}`,
      ),
    enabled: canCreate && formOpen && customerId !== '',
  });
  const expandedPayment = useQuery({
    queryKey: ['payment', expandedId],
    queryFn: () => api.get<PaymentDetail>(`/api/v1/payments/${expandedId}`),
    enabled: expandedId !== null,
  });

  const accountItems = (accounts.data?.items ?? []).filter((a) => a.active);
  const ufAccount = accountItems.find((a) => a.systemKey === 'undeposited_funds');
  const depositToOptions = accountItems.filter(
    (a) => a.bankKind === 'bank' || a.systemKey === 'undeposited_funds',
  );
  const bankAccountOptions = accountItems.filter((a) => a.bankKind === 'bank');
  const effectiveDepositTo = depositToAccountId !== '' ? depositToAccountId : (ufAccount?.id ?? '');

  const customerOptions = (customers.data?.items ?? []).filter((c) => c.active);
  const openInvoices = (customerInvoices.data?.items ?? []).filter(
    (i) => i.postingStatus === 'posted' && toCents(i.openBalance) > 0n,
  );

  // ----- allocation math (exact decimal string math) -----
  const amountCents = PRICE_PATTERN.test(amount.trim()) ? toCents(amount) : 0n;
  const checkedRows = openInvoices
    .map((inv) => ({ inv, row: allocs[inv.id] }))
    .filter((r): r is { inv: InvoiceListItem; row: AllocRow } => r.row?.checked === true);
  const allocatedCents = checkedRows.reduce((sum, r) => sum + toCents(r.row.amount), 0n);
  const remainingCents = amountCents - allocatedCents;
  const allocationsValid = checkedRows.every((r) => {
    const c = toCents(r.row.amount);
    return c > 0n && c <= toCents(r.inv.openBalance);
  });

  const canSave =
    customerId !== '' &&
    paymentDate !== '' &&
    effectiveDepositTo !== '' &&
    amountCents > 0n &&
    (autoApply || (allocationsValid && remainingCents >= 0n));

  function resetForm() {
    setCustomerId('');
    setPaymentDate(todayISO());
    setAmount('');
    setDepositToAccountId('');
    setMethod('');
    setReference('');
    setMemo('');
    setAutoApply(false);
    setAllocs({});
  }

  function toggleAllocation(inv: InvoiceListItem, checked: boolean) {
    setAllocs((prev) => {
      if (!checked) {
        return { ...prev, [inv.id]: { checked: false, amount: prev[inv.id]?.amount ?? '' } };
      }
      // Default to min(open balance, remaining to allocate).
      const allocatedExcluding = openInvoices.reduce((sum, other) => {
        if (other.id === inv.id) return sum;
        const row = prev[other.id];
        return row?.checked ? sum + toCents(row.amount) : sum;
      }, 0n);
      const currentAmountCents = PRICE_PATTERN.test(amount.trim()) ? toCents(amount) : 0n;
      const remaining = currentAmountCents - allocatedExcluding;
      const open = toCents(inv.openBalance);
      const def = remaining <= 0n ? 0n : remaining < open ? remaining : open;
      return { ...prev, [inv.id]: { checked: true, amount: centsToDecimalString(def) } };
    });
  }

  function setAllocationAmount(invoiceId: string, raw: string) {
    if (!PRICE_PATTERN.test(raw)) return;
    setAllocs((prev) => ({
      ...prev,
      [invoiceId]: { checked: prev[invoiceId]?.checked ?? true, amount: raw },
    }));
  }

  const createPayment = useMutation({
    mutationFn: () => {
      const payload: {
        customerId: string;
        paymentDate: string;
        amount: string;
        depositToAccountId: string;
        method?: string;
        reference?: string;
        memo?: string;
        allocations?: { invoiceId: string; amount: string }[];
        autoApply?: boolean;
        idempotencyKey: string;
      } = {
        customerId,
        paymentDate,
        amount: centsToDecimalString(amountCents),
        depositToAccountId: effectiveDepositTo,
        idempotencyKey: crypto.randomUUID(),
      };
      if (method.trim() !== '') payload.method = method.trim();
      if (reference.trim() !== '') payload.reference = reference.trim();
      if (memo.trim() !== '') payload.memo = memo.trim();
      if (autoApply) {
        payload.autoApply = true;
      } else if (checkedRows.length > 0) {
        payload.allocations = checkedRows.map((r) => ({
          invoiceId: r.inv.id,
          amount: centsToDecimalString(toCents(r.row.amount)),
        }));
      }
      return api.post<{ id: string; number: string }>('/api/v1/payments', payload);
    },
    onSuccess: (data) => {
      toast('success', `Payment ${data.number} received`);
      void qc.invalidateQueries({ queryKey: ['payments'] });
      void qc.invalidateQueries({ queryKey: ['invoices'] });
      void qc.invalidateQueries({ queryKey: ['payment'] });
      void qc.invalidateQueries({ queryKey: ['undeposited-receipts'] });
      setFormOpen(false);
      resetForm();
    },
  });

  const unapply = useMutation({
    mutationFn: (allocationId: string) =>
      api.post<{ ok: boolean }>(`/api/v1/payment-allocations/${allocationId}/unapply`, {
        effectiveDate: todayISO(),
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: () => {
      toast('success', 'Allocation unapplied');
      void qc.invalidateQueries({ queryKey: ['payments'] });
      void qc.invalidateQueries({ queryKey: ['payment'] });
      void qc.invalidateQueries({ queryKey: ['invoices'] });
    },
    onError: (err) =>
      toast(
        'error',
        err instanceof ApiError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : 'Unapply failed',
      ),
  });

  const voidPayment = useMutation({
    mutationFn: (input: { id: string; reason: string }) =>
      api.post<{ reversalEntryId: string }>(`/api/v1/payments/${input.id}/void`, {
        idempotencyKey: crypto.randomUUID(),
        reason: input.reason,
      }),
    onSuccess: () => {
      toast('success', 'Payment voided');
      void qc.invalidateQueries({ queryKey: ['payments'] });
      void qc.invalidateQueries({ queryKey: ['payment'] });
      void qc.invalidateQueries({ queryKey: ['invoices'] });
      void qc.invalidateQueries({ queryKey: ['undeposited-receipts'] });
      setVoidTarget(null);
    },
  });

  const refund = useMutation({
    mutationFn: (input: {
      sourceId: string;
      amount: string;
      refundDate: string;
      bankAccountId: string;
    }) =>
      api.post<{ journalEntryId: string }>('/api/v1/customer-refunds', {
        sourceType: 'payment',
        sourceId: input.sourceId,
        amount: input.amount,
        refundDate: input.refundDate,
        bankAccountId: input.bankAccountId,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: () => {
      toast('success', 'Refund recorded');
      void qc.invalidateQueries({ queryKey: ['payments'] });
      void qc.invalidateQueries({ queryKey: ['payment'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      setRefundTarget(null);
    },
  });

  const recordReturn = useMutation({
    mutationFn: (input: { id: string; returnDate: string; reason: string }) =>
      api.post<{ ok: boolean }>(`/api/v1/payments/${input.id}/return`, {
        returnDate: input.returnDate,
        reason: input.reason,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: () => {
      toast('success', 'Bank return recorded');
      void qc.invalidateQueries({ queryKey: ['payments'] });
      void qc.invalidateQueries({ queryKey: ['payment'] });
      void qc.invalidateQueries({ queryKey: ['invoices'] });
      setReturnTarget(null);
    },
  });

  if (payments.isLoading) return <Spinner label="Loading payments" />;
  if (payments.error) return <ErrorNote error={payments.error} />;

  const items = payments.items;
  const refundAmountCents = PRICE_PATTERN.test(refundAmount.trim()) ? toCents(refundAmount) : 0n;
  const refundMaxCents = refundTarget ? toCents(refundTarget.unapplied) : 0n;
  const canRefund =
    refundTarget !== null &&
    refundDate !== '' &&
    refundBankAccountId !== '' &&
    refundAmountCents > 0n &&
    refundAmountCents <= refundMaxCents;
  const canSubmitReturn =
    returnTarget !== null &&
    returnDate !== '' &&
    returnDate >= returnTarget.paymentDate &&
    returnReason.trim().length >= 3;

  // Allocations that were reversed (unapplied) or are themselves reversals are inactive.
  const detailAllocations = expandedPayment.data?.allocations ?? [];
  const reversedIds = new Set(
    detailAllocations
      .map((a) => a.reversalOfAllocationId)
      .filter((id): id is string => id !== null),
  );

  return (
    <div>
      <PageHeader
        title="Customer payments"
        description="Money received against invoices. Payments deposited to Undeposited Funds are grouped into bank deposits later."
        actions={
          canCreate ? (
            <Button
              onClick={() => {
                createPayment.reset();
                resetForm();
                setFormOpen(true);
              }}
            >
              Receive payment
            </Button>
          ) : undefined
        }
      />

      {items.length === 0 ? (
        <EmptyState
          title="No payments yet"
          description="Record a customer payment to settle open invoices."
          action={
            canCreate ? (
              <Button
                onClick={() => {
                  createPayment.reset();
                  resetForm();
                  setFormOpen(true);
                }}
              >
                Receive payment
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
              <TH>Customer</TH>
              <TH>Date</TH>
              <TH>Method / reference</TH>
              <TH>Deposited to</TH>
              <TH className="text-right">Amount</TH>
              <TH className="text-right">Unapplied</TH>
              <TH>Status</TH>
              <TH className="w-40">Actions</TH>
            </TR>
          </THead>
          <TBody>
            {items.map((p) => {
              const isExpanded = expandedId === p.id;
              const unappliedCents = toCents(p.unapplied);
              return (
                <PaymentRowGroup key={p.id}>
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
                            : `Expand payment ${p.number} to see allocations`
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
                    <TD>{p.customerName}</TD>
                    <TD className="text-muted-foreground">{formatDate(p.paymentDate)}</TD>
                    <TD className="text-muted-foreground">
                      {p.method ?? '—'}
                      {p.reference ? ` · ${p.reference}` : ''}
                    </TD>
                    <TD className="text-muted-foreground">{p.depositToName ?? '—'}</TD>
                    <TDMoney>{formatMoney(p.amount, currency)}</TDMoney>
                    <TDMoney>
                      {unappliedCents > 0n ? (
                        <span className="inline-flex items-center gap-1.5">
                          <Badge tone="warning">Unapplied</Badge>
                          {formatMoney(p.unapplied, currency)}
                        </span>
                      ) : (
                        formatMoney(p.unapplied, currency)
                      )}
                    </TDMoney>
                    <TD>
                      <span className="inline-flex items-center gap-1.5">
                        <Badge tone={STATUS_TONES[p.postingStatus]}>{p.postingStatus}</Badge>
                        {p.returnedDate !== null ? <Badge tone="danger">Returned</Badge> : null}
                      </span>
                    </TD>
                    <TD>
                      {canCreate && p.postingStatus === 'posted' && unappliedCents > 0n ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            refund.reset();
                            setRefundTarget(p);
                            setRefundAmount(centsToDecimalString(unappliedCents));
                            setRefundDate(todayISO());
                            setRefundBankAccountId('');
                          }}
                        >
                          Refund unapplied
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TD>
                  </TR>
                  {isExpanded ? (
                    <TR className="bg-muted/30 hover:bg-muted/30">
                      <TD colSpan={10} className="p-4">
                        {expandedPayment.isLoading ? (
                          <Spinner label="Loading allocations" />
                        ) : expandedPayment.error ? (
                          <ErrorNote error={expandedPayment.error} />
                        ) : (
                          <div className="space-y-3">
                            <div className="flex items-center justify-between gap-3">
                              <h4 className="text-sm font-semibold">Invoice allocations</h4>
                              <div className="flex items-center gap-2">
                                {canVoid &&
                                p.postingStatus === 'posted' &&
                                p.returnedDate === null ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => {
                                      recordReturn.reset();
                                      setReturnTarget(p);
                                      setReturnDate(todayISO());
                                      setReturnReason('');
                                    }}
                                  >
                                    Record bank return…
                                  </Button>
                                ) : null}
                                {canVoid && p.postingStatus === 'posted' ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="text-destructive"
                                    onClick={() => {
                                      voidPayment.reset();
                                      setVoidTarget(p);
                                      setVoidReason('');
                                    }}
                                  >
                                    Void payment
                                  </Button>
                                ) : null}
                              </div>
                            </div>
                            {detailAllocations.length === 0 ? (
                              <p className="text-sm text-muted-foreground">
                                This payment has no invoice allocations.
                              </p>
                            ) : (
                              <Table>
                                <THead>
                                  <TR>
                                    <TH>Invoice</TH>
                                    <TH>Effective date</TH>
                                    <TH className="text-right">Amount</TH>
                                    <TH className="w-28">
                                      <span className="sr-only">Allocation actions</span>
                                    </TH>
                                  </TR>
                                </THead>
                                <TBody>
                                  {detailAllocations.map((a) => {
                                    const isReversal = a.reversalOfAllocationId !== null;
                                    const isReversed = reversedIds.has(a.id);
                                    const active = !isReversal && !isReversed;
                                    return (
                                      <TR key={a.id}>
                                        <TD className="font-mono text-[13px]">
                                          {a.invoiceNumber}
                                          {isReversal ? (
                                            <Badge tone="warning" className="ml-2">
                                              Reversal
                                            </Badge>
                                          ) : isReversed ? (
                                            <Badge tone="neutral" className="ml-2">
                                              Unapplied
                                            </Badge>
                                          ) : null}
                                        </TD>
                                        <TD className="text-muted-foreground">
                                          {formatDate(a.effectiveDate)}
                                        </TD>
                                        <TDMoney>{formatMoney(a.amount, currency)}</TDMoney>
                                        <TD>
                                          {canEdit && active && p.postingStatus === 'posted' ? (
                                            <Button
                                              variant="ghost"
                                              size="sm"
                                              loading={
                                                unapply.isPending && unapply.variables === a.id
                                              }
                                              onClick={() => unapply.mutate(a.id)}
                                            >
                                              Unapply
                                            </Button>
                                          ) : null}
                                        </TD>
                                      </TR>
                                    );
                                  })}
                                </TBody>
                              </Table>
                            )}
                          </div>
                        )}
                      </TD>
                    </TR>
                  ) : null}
                </PaymentRowGroup>
              );
            })}
          </TBody>
        </Table>
      )}
      <LoadMoreButton
        hasMore={payments.hasMore}
        loading={payments.isLoadingMore}
        onClick={payments.loadMore}
      />

      {/* ----- receive payment dialog ----- */}
      <Dialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) resetForm();
        }}
        title="Receive payment"
        description="Records money received from a customer and applies it against open invoices."
        wide
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            createPayment.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="pay-customer">Customer</Label>
              <Select
                id="pay-customer"
                required
                value={customerId}
                onChange={(e) => {
                  setCustomerId(e.target.value);
                  setAllocs({});
                }}
              >
                <option value="" disabled>
                  Select a customer…
                </option>
                {customerOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pay-date">Payment date</Label>
              <Input
                id="pay-date"
                type="date"
                required
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pay-amount">Amount</Label>
              <MoneyInput
                id="pay-amount"
                required
                placeholder="0.00"
                value={amount}
                onChange={(e) => {
                  if (PRICE_PATTERN.test(e.target.value)) setAmount(e.target.value);
                }}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="pay-deposit-to">Deposit to</Label>
              <Select
                id="pay-deposit-to"
                required
                value={effectiveDepositTo}
                onChange={(e) => setDepositToAccountId(e.target.value)}
              >
                <option value="" disabled>
                  Select an account…
                </option>
                {depositToOptions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.systemKey === 'undeposited_funds' ? `${a.name} (recommended)` : a.name}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                Undeposited Funds is recommended: group receipts into deposits that match your bank
                statement.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pay-method">Method (optional)</Label>
              <Select id="pay-method" value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="">No method</option>
                <option value="cash">Cash</option>
                <option value="check">Check</option>
                <option value="ach">ACH</option>
                <option value="card">Card</option>
                <option value="wire">Wire</option>
                <option value="other">Other</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pay-reference">Reference (optional)</Label>
              <Input
                id="pay-reference"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pay-memo">Memo (optional)</Label>
            <Textarea
              id="pay-memo"
              className="min-h-[36px]"
              rows={1}
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
            />
          </div>

          <label className="flex items-center gap-2 text-sm" htmlFor="pay-auto-apply">
            <input
              id="pay-auto-apply"
              type="checkbox"
              className="h-4 w-4 rounded border-input"
              checked={autoApply}
              onChange={(e) => setAutoApply(e.target.checked)}
            />
            Auto-apply oldest first
          </label>

          {customerId === '' ? (
            <p className="text-sm text-muted-foreground">
              Select a customer to see their open invoices.
            </p>
          ) : autoApply ? (
            <p className="text-sm text-muted-foreground">
              The payment will be applied to this customer&apos;s open invoices automatically,
              oldest first.
            </p>
          ) : customerInvoices.isLoading ? (
            <Spinner label="Loading open invoices" />
          ) : customerInvoices.error ? (
            <ErrorNote error={customerInvoices.error} />
          ) : openInvoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This customer has no open invoices; the full amount will remain unapplied.
            </p>
          ) : (
            <>
              <Table>
                <THead>
                  <TR>
                    <TH className="w-12">Apply</TH>
                    <TH>Invoice</TH>
                    <TH>Due date</TH>
                    <TH className="text-right">Open balance</TH>
                    <TH className="w-32 text-right">Payment</TH>
                  </TR>
                </THead>
                <TBody>
                  {openInvoices.map((inv) => {
                    const row = allocs[inv.id];
                    const checked = row?.checked === true;
                    const rowCents = row ? toCents(row.amount) : 0n;
                    const overOpen = checked && rowCents > toCents(inv.openBalance);
                    return (
                      <TR key={inv.id}>
                        <TD className="text-center">
                          <input
                            type="checkbox"
                            aria-label={`Apply payment to invoice ${inv.number}`}
                            className="h-4 w-4 rounded border-input"
                            checked={checked}
                            onChange={(e) => toggleAllocation(inv, e.target.checked)}
                          />
                        </TD>
                        <TD className="font-mono text-[13px]">{inv.number}</TD>
                        <TD className="text-muted-foreground">{formatDate(inv.dueDate)}</TD>
                        <TDMoney>{formatMoney(inv.openBalance, currency)}</TDMoney>
                        <TD>
                          <MoneyInput
                            aria-label={`Amount to apply to invoice ${inv.number}`}
                            placeholder="0.00"
                            disabled={!checked}
                            value={checked ? (row?.amount ?? '') : ''}
                            onChange={(e) => setAllocationAmount(inv.id, e.target.value)}
                            className={overOpen ? 'border-destructive' : undefined}
                          />
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
              <div className="flex flex-wrap items-center justify-end gap-4 text-sm">
                <span className="text-muted-foreground">
                  Applied:{' '}
                  <span data-money className="font-mono tabular-nums text-foreground">
                    {formatMoney(centsToDecimalString(allocatedCents), currency)}
                  </span>
                </span>
                <span
                  className={remainingCents < 0n ? 'text-destructive' : 'text-muted-foreground'}
                >
                  Remaining to allocate:{' '}
                  <span data-money className="font-mono tabular-nums">
                    {formatMoney(centsToDecimalString(remainingCents), currency)}
                  </span>
                </span>
              </div>
            </>
          )}

          {createPayment.error ? <ApiErrorNote error={createPayment.error} /> : null}

          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {!canSave
                ? remainingCents < 0n
                  ? 'Allocations exceed the payment amount.'
                  : !allocationsValid
                    ? 'Each applied amount must be greater than zero and no more than the invoice open balance.'
                    : 'A customer, date, amount, and deposit account are required.'
                : 'Ready to save.'}
            </p>
            <Button type="submit" disabled={!canSave} loading={createPayment.isPending}>
              Receive payment
            </Button>
          </div>
        </form>
      </Dialog>

      {/* ----- void dialog ----- */}
      <Dialog
        open={voidTarget !== null}
        onOpenChange={(open) => {
          if (!open) setVoidTarget(null);
        }}
        title="Void payment"
        description={
          voidTarget
            ? `Posts a reversal that cancels payment ${voidTarget.number} of ${formatMoney(voidTarget.amount, currency)}. The original entry is never altered.`
            : undefined
        }
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!voidTarget) return;
            voidPayment.mutate({ id: voidTarget.id, reason: voidReason.trim() });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="void-reason">Reason</Label>
            <Textarea
              id="void-reason"
              required
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
            />
          </div>
          {voidPayment.error ? <ApiErrorNote error={voidPayment.error} /> : null}
          <Button
            type="submit"
            variant="destructive"
            className="w-full"
            disabled={voidReason.trim() === ''}
            loading={voidPayment.isPending}
          >
            Void payment
          </Button>
        </form>
      </Dialog>

      {/* ----- refund dialog ----- */}
      <Dialog
        open={refundTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRefundTarget(null);
        }}
        title="Refund unapplied amount"
        description={
          refundTarget
            ? `Refunds the unapplied portion of payment ${refundTarget.number} (${formatMoney(refundTarget.unapplied, currency)} available) from a bank account.`
            : undefined
        }
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!refundTarget) return;
            refund.mutate({
              sourceId: refundTarget.id,
              amount: centsToDecimalString(refundAmountCents),
              refundDate,
              bankAccountId: refundBankAccountId,
            });
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="refund-amount">Amount</Label>
              <MoneyInput
                id="refund-amount"
                required
                placeholder="0.00"
                value={refundAmount}
                onChange={(e) => {
                  if (PRICE_PATTERN.test(e.target.value)) setRefundAmount(e.target.value);
                }}
              />
              {refundTarget && refundAmountCents > refundMaxCents ? (
                <p className="text-xs text-destructive">
                  Cannot exceed the unapplied amount of{' '}
                  {formatMoney(refundTarget.unapplied, currency)}.
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="refund-date">Refund date</Label>
              <Input
                id="refund-date"
                type="date"
                required
                value={refundDate}
                onChange={(e) => setRefundDate(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="refund-bank">Refund from bank account</Label>
            <Select
              id="refund-bank"
              required
              value={refundBankAccountId}
              onChange={(e) => setRefundBankAccountId(e.target.value)}
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
          {refund.error ? <ApiErrorNote error={refund.error} /> : null}
          <Button type="submit" className="w-full" disabled={!canRefund} loading={refund.isPending}>
            Record refund
          </Button>
        </form>
      </Dialog>

      {/* ----- bank return dialog ----- */}
      <Dialog
        open={returnTarget !== null}
        onOpenChange={(open) => {
          if (!open) setReturnTarget(null);
        }}
        title="Record bank return"
        description={
          returnTarget
            ? `Records that the bank returned payment ${returnTarget.number} of ${formatMoney(returnTarget.amount, currency)} (e.g. NSF / bounced check).`
            : undefined
        }
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!returnTarget || !canSubmitReturn) return;
            recordReturn.mutate({
              id: returnTarget.id,
              returnDate,
              reason: returnReason.trim(),
            });
          }}
        >
          <p className="text-sm text-muted-foreground">
            Reversing the allocations reopens the invoices this payment paid, and the bank account
            is credited. Any NSF fee you charge the customer is a separate invoice.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="return-date">Return date</Label>
            <Input
              id="return-date"
              type="date"
              required
              min={returnTarget?.paymentDate}
              value={returnDate}
              onChange={(e) => setReturnDate(e.target.value)}
            />
            {returnTarget && returnDate !== '' && returnDate < returnTarget.paymentDate ? (
              <p className="text-xs text-destructive">
                The return date cannot be before the payment date (
                {formatDate(returnTarget.paymentDate)}).
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="return-reason">Reason</Label>
            <Textarea
              id="return-reason"
              required
              minLength={3}
              value={returnReason}
              onChange={(e) => setReturnReason(e.target.value)}
            />
            {returnReason.trim() !== '' && returnReason.trim().length < 3 ? (
              <p className="text-xs text-destructive">The reason must be at least 3 characters.</p>
            ) : null}
          </div>
          {recordReturn.error ? <ApiErrorNote error={recordReturn.error} /> : null}
          <Button
            type="submit"
            variant="destructive"
            className="w-full"
            disabled={!canSubmitReturn}
            loading={recordReturn.isPending}
          >
            Record bank return
          </Button>
        </form>
      </Dialog>
    </div>
  );
}

/** Groups a payment row with its optional expanded-details row. */
function PaymentRowGroup({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
