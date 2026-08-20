import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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

type EstimateStatus =
  | 'draft'
  | 'sent'
  | 'accepted'
  | 'rejected'
  | 'expired'
  | 'partially_converted'
  | 'converted'
  | 'closed';

interface EstimateListItem {
  id: string;
  number: string;
  customerId: string;
  customerName: string;
  status: EstimateStatus;
  estimateDate: string;
  expirationDate: string | null;
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

const STATUS_ORDER: EstimateStatus[] = [
  'draft',
  'sent',
  'accepted',
  'rejected',
  'expired',
  'partially_converted',
  'converted',
  'closed',
];

const STATUS_LABELS: Record<EstimateStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  accepted: 'Accepted',
  rejected: 'Rejected',
  expired: 'Expired',
  partially_converted: 'Partially converted',
  converted: 'Converted',
  closed: 'Closed',
};

const STATUS_TONES: Record<EstimateStatus, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> =
  {
    draft: 'neutral',
    sent: 'info',
    accepted: 'success',
    rejected: 'danger',
    expired: 'danger',
    partially_converted: 'warning',
    converted: 'success',
    closed: 'neutral',
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

export function EstimatesPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();
  const currency = me.company?.homeCurrency ?? 'USD';
  const canCreate = can(me, 'estimates.create');

  const [statusFilter, setStatusFilter] = useState<'all' | EstimateStatus>('all');

  // ----- new estimate dialog state -----
  const [formOpen, setFormOpen] = useState(false);
  const [customerId, setCustomerId] = useState('');
  const [estimateDate, setEstimateDate] = useState(todayISO());
  const [expirationDate, setExpirationDate] = useState('');
  const [taxRateId, setTaxRateId] = useState('');
  const [customerMessage, setCustomerMessage] = useState('');
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<FormLine[]>([emptyLine()]);

  const estimates = useQuery({
    queryKey: ['estimates'],
    queryFn: () => api.get<{ items: EstimateListItem[] }>('/api/v1/estimates'),
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

  const allLinesComplete = lines.every(lineIsComplete);
  const canSave = customerId !== '' && estimateDate !== '' && lines.length >= 1 && allLinesComplete;

  function resetForm() {
    setCustomerId('');
    setEstimateDate(todayISO());
    setExpirationDate('');
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

  const createEstimate = useMutation({
    mutationFn: () => {
      const payload: {
        customerId: string;
        estimateDate: string;
        expirationDate?: string;
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
        estimateDate,
        lines: lines.map((l) => ({
          productId: l.productId !== '' ? l.productId : undefined,
          description: l.description.trim() !== '' ? l.description.trim() : undefined,
          quantity: l.quantity.trim(),
          unitPrice: centsToDecimalString(toCents(l.unitPrice)),
          taxable: l.taxable,
        })),
      };
      if (expirationDate !== '') payload.expirationDate = expirationDate;
      if (memo.trim() !== '') payload.memo = memo.trim();
      if (customerMessage.trim() !== '') payload.customerMessage = customerMessage.trim();
      if (taxRateId !== '') payload.taxRateId = taxRateId;
      return api.post<{ id: string; number: string }>('/api/v1/estimates', payload);
    },
    onSuccess: (data) => {
      toast('success', `Estimate ${data.number} created`);
      void qc.invalidateQueries({ queryKey: ['estimates'] });
      setFormOpen(false);
      resetForm();
      navigate(`/sales/estimates/${data.id}`);
    },
  });

  const filtered = useMemo(() => {
    const items = estimates.data?.items ?? [];
    return statusFilter === 'all' ? items : items.filter((e) => e.status === statusFilter);
  }, [estimates.data, statusFilter]);

  if (estimates.isLoading) return <Spinner label="Loading estimates" />;
  if (estimates.error) return <ErrorNote error={estimates.error} />;

  return (
    <div>
      <PageHeader
        title="Estimates"
        description="Quotes for customers. Accepted estimates can be converted into invoices, in full or line by line."
        actions={
          canCreate ? (
            <Button
              onClick={() => {
                createEstimate.reset();
                resetForm();
                setFormOpen(true);
              }}
            >
              New estimate
            </Button>
          ) : undefined
        }
      />

      <div
        className="mb-4 flex flex-wrap items-center gap-1"
        role="group"
        aria-label="Filter by status"
      >
        <Button
          variant={statusFilter === 'all' ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => setStatusFilter('all')}
        >
          All
        </Button>
        {STATUS_ORDER.map((s) => (
          <Button
            key={s}
            variant={statusFilter === s ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setStatusFilter(s)}
          >
            {STATUS_LABELS[s]}
          </Button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title={statusFilter === 'all' ? 'No estimates yet' : 'No estimates with this status'}
          description={
            statusFilter === 'all'
              ? 'Create an estimate to quote work before invoicing.'
              : 'Try another status filter.'
          }
          action={
            canCreate && statusFilter === 'all' ? (
              <Button
                onClick={() => {
                  createEstimate.reset();
                  resetForm();
                  setFormOpen(true);
                }}
              >
                New estimate
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
              <TH>Expiration</TH>
              <TH>Status</TH>
              <TH className="text-right">Total</TH>
            </TR>
          </THead>
          <TBody>
            {filtered.map((e) => (
              <TR
                key={e.id}
                className="cursor-pointer"
                onClick={() => navigate(`/sales/estimates/${e.id}`)}
              >
                <TD>
                  <button
                    type="button"
                    className="text-left font-mono text-[13px] font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      navigate(`/sales/estimates/${e.id}`);
                    }}
                  >
                    {e.number}
                  </button>
                </TD>
                <TD>{e.customerName}</TD>
                <TD className="text-muted-foreground">{formatDate(e.estimateDate)}</TD>
                <TD className="text-muted-foreground">{formatDate(e.expirationDate)}</TD>
                <TD>
                  <Badge tone={STATUS_TONES[e.status]}>{STATUS_LABELS[e.status]}</Badge>
                </TD>
                <TDMoney>{formatMoney(e.total, currency)}</TDMoney>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      {/* ----- new estimate dialog ----- */}
      <Dialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) resetForm();
        }}
        title="New estimate"
        description="Estimates never post to the ledger; converting one creates an invoice."
        wide
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            createEstimate.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="est-customer">Customer</Label>
              <Select
                id="est-customer"
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
              <Label htmlFor="est-date">Estimate date</Label>
              <Input
                id="est-date"
                type="date"
                required
                value={estimateDate}
                onChange={(e) => setEstimateDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="est-expiration">Expiration date (optional)</Label>
              <Input
                id="est-expiration"
                type="date"
                value={expirationDate}
                onChange={(e) => setExpirationDate(e.target.value)}
              />
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
              <Label htmlFor="est-tax-rate">Tax rate (optional)</Label>
              <Select
                id="est-tax-rate"
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
              <Label htmlFor="est-message">Customer message (optional)</Label>
              <Textarea
                id="est-message"
                value={customerMessage}
                onChange={(e) => setCustomerMessage(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="est-memo">Memo (optional)</Label>
              <Textarea id="est-memo" value={memo} onChange={(e) => setMemo(e.target.value)} />
            </div>
          </div>

          {createEstimate.error ? <ErrorNote error={createEstimate.error} /> : null}

          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {!canSave
                ? 'A customer, a date, and at least one line with a quantity and unit price are required.'
                : 'Ready to save.'}
            </p>
            <Button type="submit" disabled={!canSave} loading={createEstimate.isPending}>
              Create estimate
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
