import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
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
import { Table, TBody, TD, TDMoney, TFoot, TH, THead, TR } from '@/components/ui/table';

type PostingStatus = 'draft' | 'posted' | 'voided' | 'reversed';

interface CreditMemoListItem {
  id: string;
  number: string;
  customerId: string;
  customerName: string;
  postingStatus: PostingStatus;
  creditDate: string;
  total: string;
  unapplied: string;
}

interface Customer {
  id: string;
  displayName: string;
  active: boolean;
}

interface Product {
  id: string;
  type: 'service' | 'non_inventory';
  name: string;
  sku: string | null;
  salesDescription: string | null;
  salesPrice: string | null;
  taxable: boolean;
  active: boolean;
}

interface TaxRate {
  id: string;
  name: string;
  agencyName: string | null;
  /** Fraction string, e.g. '0.0825'. */
  rate: string;
  active: boolean;
}

interface Account {
  id: string;
  number: string | null;
  name: string;
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

/** quantity × unitPrice as cents, rounded half-up to 2dp. */
function lineAmountCents(quantity: string, unitPrice: string): bigint {
  const q = scaledParts(quantity);
  const p = scaledParts(unitPrice);
  const product = q.n * p.n;
  const scale = q.scale + p.scale;
  if (scale <= 2) return product * 10n ** BigInt(2 - scale);
  return roundHalfUpDiv(product, 10n ** BigInt(scale - 2));
}

/** taxableCents × fraction (e.g. '0.0825'), rounded half-up to cents. */
function taxCentsFromFraction(taxableCents: bigint, fraction: string): bigint {
  const { n, scale } = scaledParts(fraction);
  if (scale === 0) return taxableCents * n;
  return roundHalfUpDiv(taxableCents * n, 10n ** BigInt(scale));
}

const PRICE_PATTERN = /^\d*(\.\d{0,2})?$/;
const QTY_PATTERN = /^\d*(\.\d{0,4})?$/;

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

// ---------------------------------------------------------------------------
// Line-editor state
// ---------------------------------------------------------------------------

interface FormLine {
  key: string;
  productId: string;
  description: string;
  quantity: string;
  unitPrice: string;
  taxable: boolean;
}

function emptyLine(): FormLine {
  return {
    key: crypto.randomUUID(),
    productId: '',
    description: '',
    quantity: '1',
    unitPrice: '',
    taxable: false,
  };
}

function lineIsComplete(l: FormLine): boolean {
  return (
    QTY_PATTERN.test(l.quantity) &&
    scaledParts(l.quantity).n > 0n &&
    l.unitPrice.trim() !== '' &&
    PRICE_PATTERN.test(l.unitPrice.trim())
  );
}

export function CreditMemosPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const currency = me.company?.homeCurrency ?? 'USD';
  const canCreate = can(me, 'credit_memos.create');
  const canPost = can(me, 'credit_memos.post');
  const canRefundPerm = can(me, 'customer_payments.create');

  // ----- new credit memo dialog state -----
  const [formOpen, setFormOpen] = useState(false);
  const [customerId, setCustomerId] = useState('');
  const [creditDate, setCreditDate] = useState(todayISO());
  const [taxRateId, setTaxRateId] = useState('');
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<FormLine[]>([emptyLine()]);

  // ----- apply dialog state -----
  const [applyTarget, setApplyTarget] = useState<CreditMemoListItem | null>(null);
  const [applyAmounts, setApplyAmounts] = useState<Record<string, string>>({});

  // ----- refund dialog state -----
  const [refundTarget, setRefundTarget] = useState<CreditMemoListItem | null>(null);
  const [refundAmount, setRefundAmount] = useState('');
  const [refundDate, setRefundDate] = useState(todayISO());
  const [refundBankAccountId, setRefundBankAccountId] = useState('');

  const creditMemos = usePagedList<CreditMemoListItem>(['credit-memos'], '/api/v1/credit-memos');
  const customers = useQuery({
    queryKey: ['customers'],
    queryFn: () => api.get<{ items: Customer[] }>('/api/v1/customers'),
    enabled: canCreate,
  });
  const products = useQuery({
    queryKey: ['products'],
    queryFn: () => api.get<{ items: Product[] }>('/api/v1/products'),
    enabled: canCreate,
  });
  const taxRates = useQuery({
    queryKey: ['tax-rates'],
    queryFn: () => api.get<{ items: TaxRate[] }>('/api/v1/tax-rates'),
    enabled: canCreate,
  });
  const accounts = useQuery({
    queryKey: ['accounts', 'for-credit-memos'],
    queryFn: () => api.get<{ items: Account[] }>('/api/v1/accounts?withBalances=true'),
    enabled: canRefundPerm,
  });
  const applyInvoices = useQuery({
    queryKey: ['invoices', { customerId: applyTarget?.customerId ?? '' }],
    queryFn: () =>
      api.get<{ items: InvoiceListItem[] }>(
        `/api/v1/invoices?customerId=${encodeURIComponent(applyTarget?.customerId ?? '')}`,
      ),
    enabled: applyTarget !== null,
  });

  const customerOptions = (customers.data?.items ?? []).filter((c) => c.active);
  const productOptions = (products.data?.items ?? []).filter((p) => p.active);
  const taxRateOptions = (taxRates.data?.items ?? []).filter((t) => t.active);
  const selectedTaxRate = taxRateOptions.find((t) => t.id === taxRateId) ?? null;
  const bankAccountOptions = (accounts.data?.items ?? []).filter(
    (a) => a.active && a.bankKind === 'bank',
  );

  // ----- form totals (exact decimal string math) -----
  const subtotalCents = lines.reduce(
    (sum, l) => sum + (lineIsComplete(l) ? lineAmountCents(l.quantity, l.unitPrice) : 0n),
    0n,
  );
  const taxableCents = lines.reduce(
    (sum, l) =>
      sum + (l.taxable && lineIsComplete(l) ? lineAmountCents(l.quantity, l.unitPrice) : 0n),
    0n,
  );
  const taxCents = selectedTaxRate ? taxCentsFromFraction(taxableCents, selectedTaxRate.rate) : 0n;
  const totalCents = subtotalCents + taxCents;

  const allLinesComplete = lines.every(lineIsComplete);
  const canSave = customerId !== '' && creditDate !== '' && lines.length >= 1 && allLinesComplete;

  function resetForm() {
    setCustomerId('');
    setCreditDate(todayISO());
    setTaxRateId('');
    setMemo('');
    setLines([emptyLine()]);
  }

  function updateLine(key: string, patch: Partial<FormLine>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function selectProduct(key: string, productId: string) {
    if (productId === '') {
      updateLine(key, { productId: '' });
      return;
    }
    const p = productOptions.find((x) => x.id === productId);
    if (!p) return;
    updateLine(key, {
      productId,
      description: p.salesDescription ?? p.name,
      unitPrice:
        p.salesPrice !== null && p.salesPrice !== ''
          ? centsToDecimalString(toCents(p.salesPrice))
          : '',
      taxable: p.taxable,
    });
  }

  const createCreditMemo = useMutation({
    mutationFn: () => {
      const payload: {
        customerId: string;
        creditDate: string;
        memo?: string;
        taxRateId?: string;
        lines: {
          productId?: string;
          description?: string;
          quantity: string;
          unitPrice: string;
          taxable?: boolean;
        }[];
      } = {
        customerId,
        creditDate,
        lines: lines.map((l) => ({
          productId: l.productId !== '' ? l.productId : undefined,
          description: l.description.trim() !== '' ? l.description.trim() : undefined,
          quantity: l.quantity.trim(),
          unitPrice: centsToDecimalString(toCents(l.unitPrice)),
          taxable: l.taxable,
        })),
      };
      if (memo.trim() !== '') payload.memo = memo.trim();
      if (taxRateId !== '') payload.taxRateId = taxRateId;
      return api.post<{ id: string; number: string }>('/api/v1/credit-memos', payload);
    },
    onSuccess: (data) => {
      toast('success', `Credit memo ${data.number} created`);
      void qc.invalidateQueries({ queryKey: ['credit-memos'] });
      setFormOpen(false);
      resetForm();
    },
  });

  const postCreditMemo = useMutation({
    mutationFn: (id: string) =>
      api.post<{ journalEntryId: string }>(`/api/v1/credit-memos/${id}/post`, {
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: () => {
      toast('success', 'Credit memo posted');
      void qc.invalidateQueries({ queryKey: ['credit-memos'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
    },
    onError: (err) =>
      toast(
        'error',
        err instanceof ApiError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : 'Post failed',
      ),
  });

  // ----- apply dialog derived values -----
  const openApplyInvoices = (applyInvoices.data?.items ?? []).filter(
    (i) => i.postingStatus === 'posted' && toCents(i.openBalance) > 0n,
  );
  const applyRows = openApplyInvoices
    .map((inv) => ({ inv, amount: applyAmounts[inv.id] ?? '' }))
    .filter((r) => r.amount.trim() !== '' && toCents(r.amount) > 0n);
  const appliedCents = applyRows.reduce((sum, r) => sum + toCents(r.amount), 0n);
  const applyAvailableCents = applyTarget ? toCents(applyTarget.unapplied) : 0n;
  const applyRemainingCents = applyAvailableCents - appliedCents;
  const applyRowsValid = applyRows.every((r) => toCents(r.amount) <= toCents(r.inv.openBalance));
  const canApply = applyRows.length > 0 && applyRowsValid && applyRemainingCents >= 0n;

  const applyCredit = useMutation({
    mutationFn: () => {
      if (!applyTarget) throw new Error('No credit memo selected');
      return api.post<{ ok: boolean }>(`/api/v1/credit-memos/${applyTarget.id}/apply`, {
        allocations: applyRows.map((r) => ({
          invoiceId: r.inv.id,
          amount: centsToDecimalString(toCents(r.amount)),
        })),
        effectiveDate: todayISO(),
        idempotencyKey: crypto.randomUUID(),
      });
    },
    onSuccess: () => {
      toast('success', 'Credit applied to invoices');
      void qc.invalidateQueries({ queryKey: ['credit-memos'] });
      void qc.invalidateQueries({ queryKey: ['invoices'] });
      setApplyTarget(null);
      setApplyAmounts({});
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
        sourceType: 'credit_memo',
        sourceId: input.sourceId,
        amount: input.amount,
        refundDate: input.refundDate,
        bankAccountId: input.bankAccountId,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: () => {
      toast('success', 'Refund recorded');
      void qc.invalidateQueries({ queryKey: ['credit-memos'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      setRefundTarget(null);
    },
  });

  if (creditMemos.isLoading) return <Spinner label="Loading credit memos" />;
  if (creditMemos.error) return <ErrorNote error={creditMemos.error} />;

  const items = creditMemos.items;
  const refundAmountCents = PRICE_PATTERN.test(refundAmount.trim()) ? toCents(refundAmount) : 0n;
  const refundMaxCents = refundTarget ? toCents(refundTarget.unapplied) : 0n;
  const canRefund =
    refundTarget !== null &&
    refundDate !== '' &&
    refundBankAccountId !== '' &&
    refundAmountCents > 0n &&
    refundAmountCents <= refundMaxCents;

  return (
    <div>
      <PageHeader
        title="Credit memos"
        description="Credits owed to customers. Posted credits can be applied against open invoices or refunded from a bank account."
        actions={
          canCreate ? (
            <Button
              onClick={() => {
                createCreditMemo.reset();
                resetForm();
                setFormOpen(true);
              }}
            >
              New credit memo
            </Button>
          ) : undefined
        }
      />

      {items.length === 0 ? (
        <EmptyState
          title="No credit memos yet"
          description="Create a credit memo when a customer is owed money for returned goods or adjustments."
          action={
            canCreate ? (
              <Button
                onClick={() => {
                  createCreditMemo.reset();
                  resetForm();
                  setFormOpen(true);
                }}
              >
                New credit memo
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Number</TH>
              <TH>Customer</TH>
              <TH>Date</TH>
              <TH className="text-right">Total</TH>
              <TH className="text-right">Unapplied</TH>
              <TH>Status</TH>
              <TH className="w-56">Actions</TH>
            </TR>
          </THead>
          <TBody>
            {items.map((cm) => {
              const unappliedCents = toCents(cm.unapplied);
              return (
                <TR key={cm.id}>
                  <TD className="font-mono text-[13px] font-medium">{cm.number}</TD>
                  <TD>{cm.customerName}</TD>
                  <TD className="text-muted-foreground">{formatDate(cm.creditDate)}</TD>
                  <TDMoney>{formatMoney(cm.total, currency)}</TDMoney>
                  <TDMoney>
                    {unappliedCents > 0n && cm.postingStatus === 'posted' ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Badge tone="warning">Unapplied</Badge>
                        {formatMoney(cm.unapplied, currency)}
                      </span>
                    ) : (
                      formatMoney(cm.unapplied, currency)
                    )}
                  </TDMoney>
                  <TD>
                    <Badge tone={STATUS_TONES[cm.postingStatus]}>{cm.postingStatus}</Badge>
                  </TD>
                  <TD>
                    <div className="flex flex-wrap items-center gap-1">
                      {cm.postingStatus === 'draft' && canPost ? (
                        <Button
                          variant="outline"
                          size="sm"
                          loading={postCreditMemo.isPending && postCreditMemo.variables === cm.id}
                          onClick={() => postCreditMemo.mutate(cm.id)}
                        >
                          Post
                        </Button>
                      ) : null}
                      {cm.postingStatus === 'posted' && unappliedCents > 0n && canPost ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            applyCredit.reset();
                            setApplyAmounts({});
                            setApplyTarget(cm);
                          }}
                        >
                          Apply to invoices
                        </Button>
                      ) : null}
                      {cm.postingStatus === 'posted' && unappliedCents > 0n && canRefundPerm ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            refund.reset();
                            setRefundTarget(cm);
                            setRefundAmount(centsToDecimalString(unappliedCents));
                            setRefundDate(todayISO());
                            setRefundBankAccountId('');
                          }}
                        >
                          Refund
                        </Button>
                      ) : null}
                    </div>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
      <LoadMoreButton
        hasMore={creditMemos.hasMore}
        loading={creditMemos.isLoadingMore}
        onClick={creditMemos.loadMore}
      />

      {/* ----- new credit memo dialog ----- */}
      <Dialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) resetForm();
        }}
        title="New credit memo"
        description="Creates a draft credit; posting it credits the customer's balance in the ledger."
        wide
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            createCreditMemo.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="cm-customer">Customer</Label>
              <Select
                id="cm-customer"
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
              <Label htmlFor="cm-date">Credit date</Label>
              <Input
                id="cm-date"
                type="date"
                required
                value={creditDate}
                onChange={(e) => setCreditDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cm-tax-rate">Tax rate (optional)</Label>
              <Select
                id="cm-tax-rate"
                value={taxRateId}
                onChange={(e) => setTaxRateId(e.target.value)}
              >
                <option value="">No tax</option>
                {taxRateOptions.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <Table>
            <THead>
              <TR>
                <TH className="w-44">Product</TH>
                <TH>Description</TH>
                <TH className="w-24 text-right">Qty</TH>
                <TH className="w-28 text-right">Unit price</TH>
                <TH className="w-14">Tax</TH>
                <TH className="w-28 text-right">Amount</TH>
                <TH className="w-12">
                  <span className="sr-only">Remove line</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {lines.map((l, idx) => (
                <TR key={l.key}>
                  <TD>
                    <Select
                      aria-label={`Product for line ${idx + 1}`}
                      value={l.productId}
                      onChange={(e) => selectProduct(l.key, e.target.value)}
                    >
                      <option value="">No product</option>
                      {productOptions.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.sku ? `${p.name} (${p.sku})` : p.name}
                        </option>
                      ))}
                    </Select>
                  </TD>
                  <TD>
                    <Input
                      aria-label={`Description for line ${idx + 1}`}
                      value={l.description}
                      onChange={(e) => updateLine(l.key, { description: e.target.value })}
                    />
                  </TD>
                  <TD>
                    <MoneyInput
                      aria-label={`Quantity for line ${idx + 1}`}
                      placeholder="1"
                      value={l.quantity}
                      onChange={(e) => {
                        if (QTY_PATTERN.test(e.target.value)) {
                          updateLine(l.key, { quantity: e.target.value });
                        }
                      }}
                    />
                  </TD>
                  <TD>
                    <MoneyInput
                      aria-label={`Unit price for line ${idx + 1}`}
                      placeholder="0.00"
                      value={l.unitPrice}
                      onChange={(e) => {
                        if (PRICE_PATTERN.test(e.target.value)) {
                          updateLine(l.key, { unitPrice: e.target.value });
                        }
                      }}
                    />
                  </TD>
                  <TD className="text-center">
                    <input
                      type="checkbox"
                      aria-label={`Taxable for line ${idx + 1}`}
                      className="h-4 w-4 rounded border-input"
                      checked={l.taxable}
                      onChange={(e) => updateLine(l.key, { taxable: e.target.checked })}
                    />
                  </TD>
                  <TDMoney>
                    {lineIsComplete(l)
                      ? formatMoney(
                          centsToDecimalString(lineAmountCents(l.quantity, l.unitPrice)),
                          currency,
                        )
                      : '—'}
                  </TDMoney>
                  <TD>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove line ${idx + 1}`}
                      disabled={lines.length <= 1}
                      onClick={() =>
                        setLines((prev) =>
                          prev.length > 1 ? prev.filter((x) => x.key !== l.key) : prev,
                        )
                      }
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
            <TFoot>
              <TR>
                <TD
                  colSpan={5}
                  className="text-right text-xs uppercase tracking-wide text-muted-foreground"
                >
                  Subtotal
                </TD>
                <TDMoney>{formatMoney(centsToDecimalString(subtotalCents), currency)}</TDMoney>
                <TD />
              </TR>
              {selectedTaxRate ? (
                <TR>
                  <TD
                    colSpan={5}
                    className="text-right text-xs uppercase tracking-wide text-muted-foreground"
                  >
                    Tax ({selectedTaxRate.name})
                  </TD>
                  <TDMoney>{formatMoney(centsToDecimalString(taxCents), currency)}</TDMoney>
                  <TD />
                </TR>
              ) : null}
              <TR>
                <TD
                  colSpan={5}
                  className="text-right text-xs font-semibold uppercase tracking-wide"
                >
                  Total
                </TD>
                <TDMoney className="font-semibold">
                  {formatMoney(centsToDecimalString(totalCents), currency)}
                </TDMoney>
                <TD />
              </TR>
            </TFoot>
          </Table>

          <div className="flex items-start justify-between gap-3">
            <Button variant="outline" onClick={() => setLines((prev) => [...prev, emptyLine()])}>
              Add line
            </Button>
            <div className="w-72 space-y-1.5">
              <Label htmlFor="cm-memo">Memo (optional)</Label>
              <Textarea
                id="cm-memo"
                className="min-h-[36px]"
                rows={1}
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
              />
            </div>
          </div>

          {createCreditMemo.error ? <ApiErrorNote error={createCreditMemo.error} /> : null}

          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {!canSave
                ? 'A customer, a date, and at least one line with a quantity and unit price are required.'
                : 'Ready to save.'}
            </p>
            <Button type="submit" disabled={!canSave} loading={createCreditMemo.isPending}>
              Create credit memo
            </Button>
          </div>
        </form>
      </Dialog>

      {/* ----- apply to invoices dialog ----- */}
      <Dialog
        open={applyTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setApplyTarget(null);
            setApplyAmounts({});
          }
        }}
        title="Apply credit to invoices"
        description={
          applyTarget
            ? `Apply the unapplied balance of ${applyTarget.number} (${formatMoney(applyTarget.unapplied, currency)} available) against ${applyTarget.customerName}'s open invoices.`
            : undefined
        }
        wide
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            applyCredit.mutate();
          }}
        >
          {applyInvoices.isLoading ? (
            <Spinner label="Loading open invoices" />
          ) : applyInvoices.error ? (
            <ErrorNote error={applyInvoices.error} />
          ) : openApplyInvoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This customer has no open invoices to apply the credit against.
            </p>
          ) : (
            <>
              <Table>
                <THead>
                  <TR>
                    <TH>Invoice</TH>
                    <TH>Due date</TH>
                    <TH className="text-right">Open balance</TH>
                    <TH className="w-32 text-right">Credit to apply</TH>
                  </TR>
                </THead>
                <TBody>
                  {openApplyInvoices.map((inv) => {
                    const raw = applyAmounts[inv.id] ?? '';
                    const overOpen = raw.trim() !== '' && toCents(raw) > toCents(inv.openBalance);
                    return (
                      <TR key={inv.id}>
                        <TD className="font-mono text-[13px]">{inv.number}</TD>
                        <TD className="text-muted-foreground">{formatDate(inv.dueDate)}</TD>
                        <TDMoney>{formatMoney(inv.openBalance, currency)}</TDMoney>
                        <TD>
                          <MoneyInput
                            aria-label={`Credit to apply to invoice ${inv.number}`}
                            placeholder="0.00"
                            value={raw}
                            onChange={(e) => {
                              if (PRICE_PATTERN.test(e.target.value)) {
                                setApplyAmounts((prev) => ({
                                  ...prev,
                                  [inv.id]: e.target.value,
                                }));
                              }
                            }}
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
                  Applying:{' '}
                  <span data-money className="font-mono tabular-nums text-foreground">
                    {formatMoney(centsToDecimalString(appliedCents), currency)}
                  </span>
                </span>
                <span
                  className={
                    applyRemainingCents < 0n ? 'text-destructive' : 'text-muted-foreground'
                  }
                >
                  Credit remaining:{' '}
                  <span data-money className="font-mono tabular-nums">
                    {formatMoney(centsToDecimalString(applyRemainingCents), currency)}
                  </span>
                </span>
              </div>
            </>
          )}

          {applyCredit.error ? <ApiErrorNote error={applyCredit.error} /> : null}

          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {applyRows.length === 0
                ? 'Enter an amount against at least one invoice.'
                : !applyRowsValid
                  ? 'No amount may exceed the invoice open balance.'
                  : applyRemainingCents < 0n
                    ? 'Amounts exceed the unapplied credit.'
                    : 'Ready to apply.'}
            </p>
            <Button type="submit" disabled={!canApply} loading={applyCredit.isPending}>
              Apply credit
            </Button>
          </div>
        </form>
      </Dialog>

      {/* ----- refund dialog ----- */}
      <Dialog
        open={refundTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRefundTarget(null);
        }}
        title="Refund credit memo"
        description={
          refundTarget
            ? `Refunds the unapplied balance of ${refundTarget.number} (${formatMoney(refundTarget.unapplied, currency)} available) from a bank account.`
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
              <Label htmlFor="cm-refund-amount">Amount</Label>
              <MoneyInput
                id="cm-refund-amount"
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
              <Label htmlFor="cm-refund-date">Refund date</Label>
              <Input
                id="cm-refund-date"
                type="date"
                required
                value={refundDate}
                onChange={(e) => setRefundDate(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cm-refund-bank">Refund from bank account</Label>
            <Select
              id="cm-refund-bank"
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
    </div>
  );
}
