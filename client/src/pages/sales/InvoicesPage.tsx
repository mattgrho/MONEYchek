import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
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
type SettlementStatus = null | 'open' | 'partially_paid' | 'paid';

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
  settlementStatus: SettlementStatus;
}

interface Customer {
  id: string;
  displayName: string;
  termsDays: number | null;
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
const TERMS_PATTERN = /^\d+$/;

/** 'YYYY-MM-DD' + N days, computed in UTC so DST never shifts the date. */
function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d || Number.isNaN(y + m + d)) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Status presentation
// ---------------------------------------------------------------------------

type StatusTab = 'all' | 'draft' | 'open' | 'paid' | 'voided';

const STATUS_TABS: { key: StatusTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'draft', label: 'Draft' },
  { key: 'open', label: 'Open' },
  { key: 'paid', label: 'Paid' },
  { key: 'voided', label: 'Voided' },
];

function matchesTab(inv: InvoiceListItem, tab: StatusTab): boolean {
  switch (tab) {
    case 'all':
      return true;
    case 'draft':
      return inv.postingStatus === 'draft';
    case 'open':
      return inv.postingStatus === 'posted' && inv.settlementStatus !== 'paid';
    case 'paid':
      return inv.postingStatus === 'posted' && inv.settlementStatus === 'paid';
    case 'voided':
      return inv.postingStatus === 'voided' || inv.postingStatus === 'reversed';
  }
}

function statusBadge(inv: InvoiceListItem): {
  label: string;
  tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
} {
  if (inv.postingStatus === 'draft') return { label: 'Draft', tone: 'neutral' };
  if (inv.postingStatus === 'voided') return { label: 'Voided', tone: 'danger' };
  if (inv.postingStatus === 'reversed') return { label: 'Reversed', tone: 'danger' };
  if (inv.settlementStatus === 'paid') return { label: 'Paid', tone: 'success' };
  if (inv.settlementStatus === 'partially_paid')
    return { label: 'Partially paid', tone: 'warning' };
  return { label: 'Open', tone: 'info' };
}

function isOverdue(inv: InvoiceListItem, today: string): boolean {
  return (
    inv.postingStatus === 'posted' &&
    toCents(inv.openBalance) > 0n &&
    inv.dueDate !== null &&
    inv.dueDate < today
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

export function InvoicesPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();
  const currency = me.company?.homeCurrency ?? 'USD';
  const canCreate = can(me, 'invoices.create');
  const today = todayISO();

  const [searchParams, setSearchParams] = useSearchParams();
  const customerIdFilter = searchParams.get('customerId');

  const [statusTab, setStatusTab] = useState<StatusTab>('all');

  // ----- new invoice dialog state -----
  const [formOpen, setFormOpen] = useState(false);
  const [customerId, setCustomerId] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(todayISO());
  const [termsDays, setTermsDays] = useState('30');
  const [taxRateId, setTaxRateId] = useState('');
  const [customerMessage, setCustomerMessage] = useState('');
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<FormLine[]>([emptyLine()]);

  const invoices = useQuery({
    queryKey: ['invoices', { customerId: customerIdFilter }],
    queryFn: () =>
      api.get<{ items: InvoiceListItem[] }>(
        `/api/v1/invoices${
          customerIdFilter ? `?customerId=${encodeURIComponent(customerIdFilter)}` : ''
        }`,
      ),
  });
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

  const customerOptions = (customers.data?.items ?? []).filter((c) => c.active);
  const productOptions = (products.data?.items ?? []).filter((p) => p.active);
  const taxRateOptions = (taxRates.data?.items ?? []).filter((t) => t.active);
  const selectedTaxRate = taxRateOptions.find((t) => t.id === taxRateId) ?? null;

  // ----- totals (exact decimal string math) -----
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

  const termsValid = TERMS_PATTERN.test(termsDays.trim());
  const dueDatePreview =
    invoiceDate !== '' && termsValid ? addDaysISO(invoiceDate, Number(termsDays.trim())) : null;

  const allLinesComplete = lines.every(lineIsComplete);
  const canSave =
    customerId !== '' && invoiceDate !== '' && termsValid && lines.length >= 1 && allLinesComplete;

  function resetForm() {
    setCustomerId('');
    setInvoiceDate(todayISO());
    setTermsDays('30');
    setTaxRateId('');
    setCustomerMessage('');
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

  function selectCustomer(nextId: string) {
    setCustomerId(nextId);
    const c = customerOptions.find((x) => x.id === nextId);
    if (c && c.termsDays !== null && c.termsDays !== undefined) {
      setTermsDays(String(c.termsDays));
    }
  }

  const createInvoice = useMutation({
    mutationFn: () => {
      const payload: {
        customerId: string;
        invoiceDate: string;
        termsDays?: number;
        memo?: string;
        customerMessage?: string;
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
        invoiceDate,
        termsDays: Number(termsDays.trim()),
        lines: lines.map((l) => ({
          productId: l.productId !== '' ? l.productId : undefined,
          description: l.description.trim() !== '' ? l.description.trim() : undefined,
          quantity: l.quantity.trim(),
          unitPrice: centsToDecimalString(toCents(l.unitPrice)),
          taxable: l.taxable,
        })),
      };
      if (memo.trim() !== '') payload.memo = memo.trim();
      if (customerMessage.trim() !== '') payload.customerMessage = customerMessage.trim();
      if (taxRateId !== '') payload.taxRateId = taxRateId;
      return api.post<{ id: string; number: string }>('/api/v1/invoices', payload);
    },
    onSuccess: (data) => {
      toast('success', `Invoice ${data.number} created`);
      void qc.invalidateQueries({ queryKey: ['invoices'] });
      setFormOpen(false);
      resetForm();
      navigate(`/sales/invoices/${data.id}`);
    },
  });

  const items = invoices.data?.items ?? [];
  const filtered = useMemo(() => items.filter((i) => matchesTab(i, statusTab)), [items, statusTab]);

  const filteredTotalCents = filtered.reduce((sum, i) => sum + toCents(i.total), 0n);
  const filteredOpenCents = filtered.reduce((sum, i) => sum + toCents(i.openBalance), 0n);

  const filterCustomerName = customerIdFilter
    ? (items[0]?.customerName ??
      (customers.data?.items ?? []).find((c) => c.id === customerIdFilter)?.displayName ??
      null)
    : null;

  if (invoices.isLoading) return <Spinner label="Loading invoices" />;
  if (invoices.error) return <ErrorNote error={invoices.error} />;

  return (
    <div>
      <PageHeader
        title="Invoices"
        description="Bill customers on account. Posting an invoice records receivables in the ledger; drafts stay off the books."
        actions={
          canCreate ? (
            <Button
              onClick={() => {
                createInvoice.reset();
                resetForm();
                if (customerIdFilter) setCustomerId(customerIdFilter);
                setFormOpen(true);
              }}
            >
              New invoice
            </Button>
          ) : undefined
        }
      />

      {customerIdFilter ? (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
          <span>
            Showing invoices for{' '}
            <span className="font-medium">{filterCustomerName ?? 'the selected customer'}</span>.
          </span>
          <Button variant="ghost" size="sm" onClick={() => setSearchParams({})}>
            Clear filter
          </Button>
        </div>
      ) : null}

      <div
        className="mb-4 flex flex-wrap items-center gap-1"
        role="group"
        aria-label="Filter by status"
      >
        {STATUS_TABS.map((t) => (
          <Button
            key={t.key}
            variant={statusTab === t.key ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setStatusTab(t.key)}
          >
            {t.label}
          </Button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title={statusTab === 'all' ? 'No invoices yet' : 'No invoices with this status'}
          description={
            statusTab === 'all'
              ? 'Create an invoice to bill a customer on account.'
              : 'Try another status filter.'
          }
          action={
            canCreate && statusTab === 'all' ? (
              <Button
                onClick={() => {
                  createInvoice.reset();
                  resetForm();
                  if (customerIdFilter) setCustomerId(customerIdFilter);
                  setFormOpen(true);
                }}
              >
                New invoice
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
              <TH>Invoice date</TH>
              <TH>Due date</TH>
              <TH>Status</TH>
              <TH className="text-right">Total</TH>
              <TH className="text-right">Open balance</TH>
            </TR>
          </THead>
          <TBody>
            {filtered.map((inv) => {
              const badge = statusBadge(inv);
              return (
                <TR
                  key={inv.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/sales/invoices/${inv.id}`)}
                >
                  <TD>
                    <button
                      type="button"
                      className="text-left font-mono text-[13px] font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        navigate(`/sales/invoices/${inv.id}`);
                      }}
                    >
                      {inv.number}
                    </button>
                  </TD>
                  <TD>{inv.customerName}</TD>
                  <TD className="text-muted-foreground">{formatDate(inv.invoiceDate)}</TD>
                  <TD className="text-muted-foreground">{formatDate(inv.dueDate)}</TD>
                  <TD>
                    <span className="flex flex-wrap gap-1">
                      <Badge tone={badge.tone}>{badge.label}</Badge>
                      {isOverdue(inv, today) ? <Badge tone="danger">Overdue</Badge> : null}
                    </span>
                  </TD>
                  <TDMoney>{formatMoney(inv.total, currency)}</TDMoney>
                  <TDMoney>{formatMoney(inv.openBalance, currency)}</TDMoney>
                </TR>
              );
            })}
          </TBody>
          <TFoot>
            <TR>
              <TD
                colSpan={5}
                className="text-right text-xs uppercase tracking-wide text-muted-foreground"
              >
                Totals ({filtered.length} {filtered.length === 1 ? 'invoice' : 'invoices'})
              </TD>
              <TDMoney>{formatMoney(centsToDecimalString(filteredTotalCents), currency)}</TDMoney>
              <TDMoney>{formatMoney(centsToDecimalString(filteredOpenCents), currency)}</TDMoney>
            </TR>
          </TFoot>
        </Table>
      )}

      {/* ----- new invoice dialog ----- */}
      <Dialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) resetForm();
        }}
        title="New invoice"
        description="Saved as a draft; nothing posts to the ledger until the invoice is posted."
        wide
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            createInvoice.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="inv-customer">Customer</Label>
              <Select
                id="inv-customer"
                required
                value={customerId}
                onChange={(e) => selectCustomer(e.target.value)}
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
              <Label htmlFor="inv-date">Invoice date</Label>
              <Input
                id="inv-date"
                type="date"
                required
                value={invoiceDate}
                onChange={(e) => setInvoiceDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="inv-terms">Terms (days)</Label>
              <Input
                id="inv-terms"
                inputMode="numeric"
                required
                value={termsDays}
                onChange={(e) => {
                  if (e.target.value === '' || TERMS_PATTERN.test(e.target.value)) {
                    setTermsDays(e.target.value);
                  }
                }}
              />
              <p className="text-xs text-muted-foreground">
                {dueDatePreview
                  ? `Due date: ${formatDate(dueDatePreview)}`
                  : 'Enter a whole number of days.'}
              </p>
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

          <div className="flex items-center justify-between gap-3">
            <Button variant="outline" onClick={() => setLines((prev) => [...prev, emptyLine()])}>
              Add line
            </Button>
            <div className="w-56 space-y-1.5">
              <Label htmlFor="inv-tax-rate">Tax rate (optional)</Label>
              <Select
                id="inv-tax-rate"
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

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="inv-message">Customer message (optional)</Label>
              <Textarea
                id="inv-message"
                value={customerMessage}
                onChange={(e) => setCustomerMessage(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="inv-memo">Memo (optional)</Label>
              <Textarea id="inv-memo" value={memo} onChange={(e) => setMemo(e.target.value)} />
            </div>
          </div>

          {createInvoice.error ? <ErrorNote error={createInvoice.error} /> : null}

          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {!canSave
                ? 'A customer, a date, terms, and at least one line with a quantity and unit price are required.'
                : 'Ready to save.'}
            </p>
            <Button type="submit" disabled={!canSave} loading={createInvoice.isPending}>
              Create invoice
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
