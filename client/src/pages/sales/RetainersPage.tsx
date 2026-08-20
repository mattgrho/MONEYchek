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

interface RetainerListItem {
  id: string;
  number: string;
  customerId: string;
  customerName: string;
  postingStatus: PostingStatus;
  receivedDate: string;
  amount: string;
  balance: string;
}

interface RetainerApplication {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  amount: string;
  effectiveDate: string;
  reversalOfApplicationId: string | null;
}

interface RetainerDetail extends RetainerListItem {
  applications: RetainerApplication[];
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

export function RetainersPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const currency = me.company?.homeCurrency ?? 'USD';
  const canCreate = can(me, 'retainers.create');
  const canEdit = can(me, 'retainers.edit');
  const canVoid = can(me, 'retainers.void');

  const [expandedId, setExpandedId] = useState<string | null>(null);

  // ----- receive-retainer dialog state -----
  const [formOpen, setFormOpen] = useState(false);
  const [customerId, setCustomerId] = useState('');
  const [receivedDate, setReceivedDate] = useState(todayISO());
  const [amount, setAmount] = useState('');
  const [depositToAccountId, setDepositToAccountId] = useState('');
  const [method, setMethod] = useState('');
  const [reference, setReference] = useState('');
  const [memo, setMemo] = useState('');

  // ----- apply dialog state -----
  const [applyTarget, setApplyTarget] = useState<RetainerDetail | null>(null);
  const [applyEffectiveDate, setApplyEffectiveDate] = useState(todayISO());
  const [allocs, setAllocs] = useState<Record<string, AllocRow>>({});

  // ----- void dialog state -----
  const [voidTarget, setVoidTarget] = useState<RetainerDetail | null>(null);
  const [voidReason, setVoidReason] = useState('');

  const retainers = usePagedList<RetainerListItem>(['retainers'], '/api/v1/retainers');
  const customers = useQuery({
    queryKey: ['customers'],
    queryFn: () => api.get<{ items: Customer[] }>('/api/v1/customers'),
    enabled: canCreate,
  });
  const accounts = useQuery({
    queryKey: ['accounts', 'for-retainers'],
    queryFn: () => api.get<{ items: Account[] }>('/api/v1/accounts?withBalances=true'),
    enabled: canCreate,
  });
  const expandedRetainer = useQuery({
    queryKey: ['retainer', expandedId],
    queryFn: () => api.get<RetainerDetail>(`/api/v1/retainers/${expandedId}`),
    enabled: expandedId !== null,
  });
  const applyInvoices = useQuery({
    queryKey: ['invoices', { customerId: applyTarget?.customerId ?? null }],
    queryFn: () =>
      api.get<{ items: InvoiceListItem[] }>(
        `/api/v1/invoices?customerId=${encodeURIComponent(applyTarget?.customerId ?? '')}`,
      ),
    enabled: applyTarget !== null,
  });

  const customerOptions = (customers.data?.items ?? []).filter((c) => c.active);
  const bankAccountOptions = (accounts.data?.items ?? []).filter(
    (a) => a.active && a.bankKind === 'bank',
  );

  const amountCents = PRICE_PATTERN.test(amount.trim()) ? toCents(amount) : 0n;
  const canSaveRetainer =
    customerId !== '' && receivedDate !== '' && depositToAccountId !== '' && amountCents > 0n;

  function resetForm() {
    setCustomerId('');
    setReceivedDate(todayISO());
    setAmount('');
    setDepositToAccountId('');
    setMethod('');
    setReference('');
    setMemo('');
  }

  // ----- apply-dialog derived values (exact decimal string math) -----
  const openInvoices = (applyInvoices.data?.items ?? []).filter(
    (i) => i.postingStatus === 'posted' && toCents(i.openBalance) > 0n,
  );
  const applyBalanceCents = applyTarget ? toCents(applyTarget.balance) : 0n;
  const checkedRows = openInvoices
    .map((inv) => ({ inv, row: allocs[inv.id] }))
    .filter((r): r is { inv: InvoiceListItem; row: AllocRow } => r.row?.checked === true);
  const allocatedCents = checkedRows.reduce((sum, r) => sum + toCents(r.row.amount), 0n);
  const remainingCents = applyBalanceCents - allocatedCents;
  const allocationsValid = checkedRows.every((r) => {
    const c = toCents(r.row.amount);
    return c > 0n && c <= toCents(r.inv.openBalance);
  });
  const canSaveApply =
    applyTarget !== null &&
    applyEffectiveDate !== '' &&
    checkedRows.length > 0 &&
    allocationsValid &&
    remainingCents >= 0n;

  function toggleAllocation(inv: InvoiceListItem, checked: boolean) {
    setAllocs((prev) => {
      if (!checked) {
        return { ...prev, [inv.id]: { checked: false, amount: prev[inv.id]?.amount ?? '' } };
      }
      // Default to min(open balance, remaining retainer balance).
      const allocatedExcluding = openInvoices.reduce((sum, other) => {
        if (other.id === inv.id) return sum;
        const row = prev[other.id];
        return row?.checked ? sum + toCents(row.amount) : sum;
      }, 0n);
      const remaining = applyBalanceCents - allocatedExcluding;
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

  function invalidateAfterChange() {
    void qc.invalidateQueries({ queryKey: ['retainers'] });
    void qc.invalidateQueries({ queryKey: ['retainer'] });
    void qc.invalidateQueries({ queryKey: ['invoices'] });
  }

  const createRetainer = useMutation({
    mutationFn: () => {
      const payload: {
        customerId: string;
        receivedDate: string;
        amount: string;
        depositToAccountId: string;
        method?: string;
        reference?: string;
        memo?: string;
        idempotencyKey: string;
      } = {
        customerId,
        receivedDate,
        amount: centsToDecimalString(amountCents),
        depositToAccountId,
        idempotencyKey: crypto.randomUUID(),
      };
      if (method.trim() !== '') payload.method = method.trim();
      if (reference.trim() !== '') payload.reference = reference.trim();
      if (memo.trim() !== '') payload.memo = memo.trim();
      return api.post<{ id: string; number: string }>('/api/v1/retainers', payload);
    },
    onSuccess: (data) => {
      toast('success', `Retainer ${data.number} received`);
      invalidateAfterChange();
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      setFormOpen(false);
      resetForm();
    },
  });

  const applyRetainer = useMutation({
    mutationFn: (input: {
      retainerId: string;
      allocations: { invoiceId: string; amount: string }[];
      effectiveDate: string;
    }) =>
      api.post<{ ok: boolean }>(`/api/v1/retainers/${input.retainerId}/apply`, {
        allocations: input.allocations,
        effectiveDate: input.effectiveDate,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: () => {
      toast('success', 'Retainer applied');
      invalidateAfterChange();
      setApplyTarget(null);
      setAllocs({});
    },
  });

  const unapply = useMutation({
    mutationFn: (applicationId: string) =>
      api.post<{ ok: boolean }>(`/api/v1/retainer-applications/${applicationId}/unapply`, {
        effectiveDate: todayISO(),
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: () => {
      toast('success', 'Application unapplied');
      invalidateAfterChange();
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

  const voidRetainer = useMutation({
    mutationFn: (input: { id: string; reason: string }) =>
      api.post<{ ok: boolean }>(`/api/v1/retainers/${input.id}/void`, {
        reason: input.reason,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: () => {
      toast('success', 'Retainer voided');
      invalidateAfterChange();
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      setVoidTarget(null);
    },
  });

  if (retainers.isLoading) return <Spinner label="Loading retainers" />;
  if (retainers.error) return <ErrorNote error={retainers.error} />;

  const items = retainers.items;

  // Applications that were reversed (unapplied) or are themselves reversals are inactive.
  const detail = expandedRetainer.data;
  const detailApplications = detail?.applications ?? [];
  const reversedIds = new Set(
    detailApplications
      .map((a) => a.reversalOfApplicationId)
      .filter((id): id is string => id !== null),
  );

  return (
    <div>
      <PageHeader
        title="Retainers"
        description="Client money received in advance. A retainer is held as a liability — it stays off revenue and receivables until it is applied to posted invoices."
        actions={
          canCreate ? (
            <Button
              onClick={() => {
                createRetainer.reset();
                resetForm();
                setFormOpen(true);
              }}
            >
              Receive retainer
            </Button>
          ) : undefined
        }
      />

      {items.length === 0 ? (
        <EmptyState
          title="No retainers yet"
          description="Record a retainer to hold client funds until they are applied to invoices."
          action={
            canCreate ? (
              <Button
                onClick={() => {
                  createRetainer.reset();
                  resetForm();
                  setFormOpen(true);
                }}
              >
                Receive retainer
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
              <TH>Received</TH>
              <TH>Status</TH>
              <TH className="text-right">Amount</TH>
              <TH className="text-right">Available balance</TH>
            </TR>
          </THead>
          <TBody>
            {items.map((r) => {
              const isExpanded = expandedId === r.id;
              return (
                <RetainerRowGroup key={r.id}>
                  <TR>
                    <TD>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        aria-expanded={isExpanded}
                        aria-label={
                          isExpanded
                            ? `Collapse retainer ${r.number}`
                            : `Expand retainer ${r.number} to see applications`
                        }
                        onClick={() => setExpandedId(isExpanded ? null : r.id)}
                      >
                        {isExpanded ? (
                          <ChevronDown className="h-4 w-4" aria-hidden />
                        ) : (
                          <ChevronRight className="h-4 w-4" aria-hidden />
                        )}
                      </Button>
                    </TD>
                    <TD className="font-mono text-[13px] font-medium">{r.number}</TD>
                    <TD>{r.customerName}</TD>
                    <TD className="text-muted-foreground">{formatDate(r.receivedDate)}</TD>
                    <TD>
                      <Badge tone={STATUS_TONES[r.postingStatus]}>{r.postingStatus}</Badge>
                    </TD>
                    <TDMoney>{formatMoney(r.amount, currency)}</TDMoney>
                    <TDMoney>{formatMoney(r.balance, currency)}</TDMoney>
                  </TR>
                  {isExpanded ? (
                    <TR className="bg-muted/30 hover:bg-muted/30">
                      <TD colSpan={7} className="p-4">
                        {expandedRetainer.isLoading ? (
                          <Spinner label="Loading applications" />
                        ) : expandedRetainer.error ? (
                          <ErrorNote error={expandedRetainer.error} />
                        ) : detail ? (
                          <div className="space-y-3">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                              <h4 className="text-sm font-semibold">Invoice applications</h4>
                              <div className="flex items-center gap-2">
                                {canEdit &&
                                detail.postingStatus === 'posted' &&
                                toCents(detail.balance) > 0n ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => {
                                      applyRetainer.reset();
                                      setApplyTarget(detail);
                                      setApplyEffectiveDate(todayISO());
                                      setAllocs({});
                                    }}
                                  >
                                    Apply to invoice…
                                  </Button>
                                ) : null}
                                {canVoid &&
                                detail.postingStatus === 'posted' &&
                                toCents(detail.balance) === toCents(detail.amount) ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="text-destructive"
                                    onClick={() => {
                                      voidRetainer.reset();
                                      setVoidTarget(detail);
                                      setVoidReason('');
                                    }}
                                  >
                                    Void…
                                  </Button>
                                ) : null}
                              </div>
                            </div>
                            {detailApplications.length === 0 ? (
                              <p className="text-sm text-muted-foreground">
                                This retainer has not been applied to any invoices.
                              </p>
                            ) : (
                              <Table>
                                <THead>
                                  <TR>
                                    <TH>Invoice</TH>
                                    <TH>Effective date</TH>
                                    <TH className="text-right">Amount</TH>
                                    <TH className="w-28">
                                      <span className="sr-only">Application actions</span>
                                    </TH>
                                  </TR>
                                </THead>
                                <TBody>
                                  {detailApplications.map((a) => {
                                    const isReversal = a.reversalOfApplicationId !== null;
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
                                          {canEdit &&
                                          active &&
                                          detail.postingStatus === 'posted' ? (
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
                        ) : null}
                      </TD>
                    </TR>
                  ) : null}
                </RetainerRowGroup>
              );
            })}
          </TBody>
        </Table>
      )}
      <LoadMoreButton
        hasMore={retainers.hasMore}
        loading={retainers.isLoadingMore}
        onClick={retainers.loadMore}
      />

      {/* ----- receive retainer dialog ----- */}
      <Dialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) resetForm();
        }}
        title="Receive retainer"
        description="Records client money received in advance. The funds are held as a liability until applied to invoices."
        wide
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            createRetainer.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="ret-customer">Customer</Label>
              <Select
                id="ret-customer"
                required
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
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
              <Label htmlFor="ret-date">Received date</Label>
              <Input
                id="ret-date"
                type="date"
                required
                value={receivedDate}
                onChange={(e) => setReceivedDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ret-amount">Amount</Label>
              <MoneyInput
                id="ret-amount"
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
              <Label htmlFor="ret-deposit-to">Deposit to bank account</Label>
              <Select
                id="ret-deposit-to"
                required
                value={depositToAccountId}
                onChange={(e) => setDepositToAccountId(e.target.value)}
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
            <div className="space-y-1.5">
              <Label htmlFor="ret-method">Method (optional)</Label>
              <Select id="ret-method" value={method} onChange={(e) => setMethod(e.target.value)}>
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
              <Label htmlFor="ret-reference">Reference (optional)</Label>
              <Input
                id="ret-reference"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ret-memo">Memo (optional)</Label>
            <Textarea
              id="ret-memo"
              className="min-h-[36px]"
              rows={1}
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
            />
          </div>

          {createRetainer.error ? <ApiErrorNote error={createRetainer.error} /> : null}

          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {!canSaveRetainer
                ? 'A customer, date, amount, and bank account are required.'
                : 'Ready to save.'}
            </p>
            <Button type="submit" disabled={!canSaveRetainer} loading={createRetainer.isPending}>
              Receive retainer
            </Button>
          </div>
        </form>
      </Dialog>

      {/* ----- apply to invoice dialog ----- */}
      <Dialog
        open={applyTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setApplyTarget(null);
            setAllocs({});
          }
        }}
        title="Apply retainer to invoices"
        description={
          applyTarget
            ? `Applies retainer ${applyTarget.number} (${formatMoney(applyTarget.balance, currency)} available) against ${applyTarget.customerName}'s open invoices.`
            : undefined
        }
        wide
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!applyTarget) return;
            applyRetainer.mutate({
              retainerId: applyTarget.id,
              allocations: checkedRows.map((r) => ({
                invoiceId: r.inv.id,
                amount: centsToDecimalString(toCents(r.row.amount)),
              })),
              effectiveDate: applyEffectiveDate,
            });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="apply-date">Effective date</Label>
              <Input
                id="apply-date"
                type="date"
                required
                value={applyEffectiveDate}
                onChange={(e) => setApplyEffectiveDate(e.target.value)}
              />
            </div>
          </div>

          {applyInvoices.isLoading ? (
            <Spinner label="Loading open invoices" />
          ) : applyInvoices.error ? (
            <ErrorNote error={applyInvoices.error} />
          ) : openInvoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This customer has no posted invoices with an open balance.
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
                    <TH className="w-32 text-right">Amount</TH>
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
                            aria-label={`Apply retainer to invoice ${inv.number}`}
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
                  Remaining balance:{' '}
                  <span data-money className="font-mono tabular-nums">
                    {formatMoney(centsToDecimalString(remainingCents), currency)}
                  </span>
                </span>
              </div>
            </>
          )}

          {applyRetainer.error ? <ApiErrorNote error={applyRetainer.error} /> : null}

          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {!canSaveApply
                ? remainingCents < 0n
                  ? 'Applied amounts exceed the retainer balance.'
                  : !allocationsValid
                    ? 'Each applied amount must be greater than zero and no more than the invoice open balance.'
                    : 'Check at least one invoice and enter an effective date.'
                : 'Ready to apply.'}
            </p>
            <Button type="submit" disabled={!canSaveApply} loading={applyRetainer.isPending}>
              Apply retainer
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
        title="Void retainer"
        description={
          voidTarget
            ? `Posts a reversal that cancels retainer ${voidTarget.number} of ${formatMoney(voidTarget.amount, currency)}. The original entry is never altered.`
            : undefined
        }
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!voidTarget) return;
            voidRetainer.mutate({ id: voidTarget.id, reason: voidReason.trim() });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="ret-void-reason">Reason</Label>
            <Textarea
              id="ret-void-reason"
              required
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
            />
          </div>
          {voidRetainer.error ? <ApiErrorNote error={voidRetainer.error} /> : null}
          <Button
            type="submit"
            variant="destructive"
            className="w-full"
            disabled={voidReason.trim() === ''}
            loading={voidRetainer.isPending}
          >
            Void retainer
          </Button>
        </form>
      </Dialog>
    </div>
  );
}

/** Groups a retainer row with its optional expanded-details row. */
function RetainerRowGroup({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
