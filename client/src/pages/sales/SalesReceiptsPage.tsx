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

interface SalesReceiptListItem {
  id: string;
  number: string;
  customerId: string | null;
  customerName: string | null;
  postingStatus: PostingStatus;
  receiptDate: string;
  total: string;
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

export function SalesReceiptsPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const currency = me.company?.homeCurrency ?? 'USD';
  const canCreate = can(me, 'sales_receipts.create');

  // ----- new sales receipt dialog state -----
  const [formOpen, setFormOpen] = useState(false);
  const [customerId, setCustomerId] = useState('');
  const [receiptDate, setReceiptDate] = useState(todayISO());
  const [depositToAccountId, setDepositToAccountId] = useState('');
  const [taxRateId, setTaxRateId] = useState('');
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<FormLine[]>([emptyLine()]);

  const salesReceipts = usePagedList<SalesReceiptListItem>(
    ['sales-receipts'],
    '/api/v1/sales-receipts',
  );
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
    queryKey: ['accounts', 'for-sales-receipts'],
    queryFn: () => api.get<{ items: Account[] }>('/api/v1/accounts?withBalances=true'),
    enabled: canCreate,
  });

  const customerOptions = (customers.data?.items ?? []).filter((c) => c.active);
  const productOptions = (products.data?.items ?? []).filter((p) => p.active);
  const taxRateOptions = (taxRates.data?.items ?? []).filter((t) => t.active);
  const selectedTaxRate = taxRateOptions.find((t) => t.id === taxRateId) ?? null;
  const depositToOptions = (accounts.data?.items ?? []).filter(
    (a) => a.active && (a.bankKind === 'bank' || a.systemKey === 'undeposited_funds'),
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
  const canSave =
    receiptDate !== '' && depositToAccountId !== '' && lines.length >= 1 && allLinesComplete;

  function resetForm() {
    setCustomerId('');
    setReceiptDate(todayISO());
    setDepositToAccountId('');
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

  const createSalesReceipt = useMutation({
    mutationFn: () => {
      const payload: {
        customerId?: string;
        receiptDate: string;
        depositToAccountId: string;
        memo?: string;
        taxRateId?: string;
        lines: {
          productId?: string;
          description?: string;
          quantity: string;
          unitPrice: string;
          taxable?: boolean;
        }[];
        idempotencyKey: string;
      } = {
        receiptDate,
        depositToAccountId,
        lines: lines.map((l) => ({
          productId: l.productId !== '' ? l.productId : undefined,
          description: l.description.trim() !== '' ? l.description.trim() : undefined,
          quantity: l.quantity.trim(),
          unitPrice: centsToDecimalString(toCents(l.unitPrice)),
          taxable: l.taxable,
        })),
        idempotencyKey: crypto.randomUUID(),
      };
      if (customerId !== '') payload.customerId = customerId;
      if (memo.trim() !== '') payload.memo = memo.trim();
      if (taxRateId !== '') payload.taxRateId = taxRateId;
      return api.post<{ id: string; number: string }>('/api/v1/sales-receipts', payload);
    },
    onSuccess: (data) => {
      toast('success', `Sales receipt ${data.number} recorded`);
      void qc.invalidateQueries({ queryKey: ['sales-receipts'] });
      void qc.invalidateQueries({ queryKey: ['undeposited-receipts'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      setFormOpen(false);
      resetForm();
    },
  });

  if (salesReceipts.isLoading) return <Spinner label="Loading sales receipts" />;
  if (salesReceipts.error) return <ErrorNote error={salesReceipts.error} />;

  const items = salesReceipts.items;

  return (
    <div>
      <PageHeader
        title="Sales receipts"
        description="Point-of-sale style transactions: the sale and its payment are recorded together, with no receivable created."
        actions={
          canCreate ? (
            <Button
              onClick={() => {
                createSalesReceipt.reset();
                resetForm();
                setFormOpen(true);
              }}
            >
              New sales receipt
            </Button>
          ) : undefined
        }
      />

      {items.length === 0 ? (
        <EmptyState
          title="No sales receipts yet"
          description="Record a sales receipt when a customer pays at the time of sale."
          action={
            canCreate ? (
              <Button
                onClick={() => {
                  createSalesReceipt.reset();
                  resetForm();
                  setFormOpen(true);
                }}
              >
                New sales receipt
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
              <TH>Status</TH>
            </TR>
          </THead>
          <TBody>
            {items.map((sr) => (
              <TR key={sr.id}>
                <TD className="font-mono text-[13px] font-medium">{sr.number}</TD>
                <TD>{sr.customerName ?? 'Walk-in'}</TD>
                <TD className="text-muted-foreground">{formatDate(sr.receiptDate)}</TD>
                <TDMoney>{formatMoney(sr.total, currency)}</TDMoney>
                <TD>
                  <Badge tone={STATUS_TONES[sr.postingStatus]}>{sr.postingStatus}</Badge>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      <LoadMoreButton
        hasMore={salesReceipts.hasMore}
        loading={salesReceipts.isLoadingMore}
        onClick={salesReceipts.loadMore}
      />

      {/* ----- new sales receipt dialog ----- */}
      <Dialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) resetForm();
        }}
        title="New sales receipt"
        description="A sales receipt records the sale and the money in one step."
        wide
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            createSalesReceipt.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="sr-customer">Customer (optional)</Label>
              <Select
                id="sr-customer"
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
              >
                <option value="">Walk-in customer</option>
                {customerOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sr-date">Receipt date</Label>
              <Input
                id="sr-date"
                type="date"
                required
                value={receiptDate}
                onChange={(e) => setReceiptDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sr-deposit-to">Deposit to</Label>
              <Select
                id="sr-deposit-to"
                required
                value={depositToAccountId}
                onChange={(e) => setDepositToAccountId(e.target.value)}
              >
                <option value="" disabled>
                  Select an account…
                </option>
                {depositToOptions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.number ? `${a.number} · ${a.name}` : a.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sr-tax-rate">Tax rate (optional)</Label>
              <Select
                id="sr-tax-rate"
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
              <Label htmlFor="sr-memo">Memo (optional)</Label>
              <Textarea
                id="sr-memo"
                className="min-h-[36px]"
                rows={1}
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
              />
            </div>
          </div>

          {createSalesReceipt.error ? <ApiErrorNote error={createSalesReceipt.error} /> : null}

          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {!canSave
                ? 'A date, a deposit-to account, and at least one line with a quantity and unit price are required.'
                : 'Recording posts the receipt immediately.'}
            </p>
            <Button type="submit" disabled={!canSave} loading={createSalesReceipt.isPending}>
              Record sales receipt
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
