import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
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

type PoStatus = 'draft' | 'open' | 'partially_billed' | 'billed' | 'closed' | 'canceled';

interface PurchaseOrderListItem {
  id: string;
  number: string;
  vendorId: string;
  vendorName: string;
  status: PoStatus;
  poDate: string;
  expectedDate: string | null;
  total: string;
}

interface Vendor {
  id: string;
  displayName: string;
  active: boolean;
}

interface Product {
  id: string;
  type: 'service' | 'non_inventory';
  name: string;
  sku: string | null;
  purchaseCost: string | null;
  expenseAccountId: string | null;
  active: boolean;
}

interface Account {
  id: string;
  number: string | null;
  name: string;
  category: string;
  systemKey: string | null;
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

/** quantity × unitCost as cents, rounded half-up to 2dp. */
function lineAmountCents(quantity: string, unitCost: string): bigint {
  const q = scaledParts(quantity);
  const p = scaledParts(unitCost);
  const product = q.n * p.n;
  const scale = q.scale + p.scale;
  if (scale <= 2) return product * 10n ** BigInt(2 - scale);
  return roundHalfUpDiv(product, 10n ** BigInt(scale - 2));
}

const PRICE_PATTERN = /^\d*(\.\d{0,2})?$/;
const QTY_PATTERN = /^\d*(\.\d{0,4})?$/;

/** Account categories a PO line can be coded to (system accounts excluded). */
const LINE_CATEGORIES = new Set(['expense', 'cogs']);

// ---------------------------------------------------------------------------
// Status presentation
// ---------------------------------------------------------------------------

function statusBadge(status: PoStatus): {
  label: string;
  tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
} {
  switch (status) {
    case 'draft':
      return { label: 'Draft', tone: 'neutral' };
    case 'open':
      return { label: 'Open', tone: 'info' };
    case 'partially_billed':
      return { label: 'Partially billed', tone: 'warning' };
    case 'billed':
      return { label: 'Billed', tone: 'success' };
    case 'closed':
      return { label: 'Closed', tone: 'neutral' };
    case 'canceled':
      return { label: 'Canceled', tone: 'danger' };
  }
}

// ---------------------------------------------------------------------------
// Line-editor state
// ---------------------------------------------------------------------------

interface FormLine {
  key: string;
  productId: string;
  accountId: string;
  description: string;
  quantity: string;
  unitCost: string;
}

function emptyLine(): FormLine {
  return {
    key: crypto.randomUUID(),
    productId: '',
    accountId: '',
    description: '',
    quantity: '1',
    unitCost: '',
  };
}

export function PurchaseOrdersPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();
  const currency = me.company?.homeCurrency ?? 'USD';
  const canCreate = can(me, 'purchase_orders.create');

  // ----- new purchase order dialog state -----
  const [formOpen, setFormOpen] = useState(false);
  const [vendorId, setVendorId] = useState('');
  const [poDate, setPoDate] = useState(todayISO());
  const [expectedDate, setExpectedDate] = useState('');
  const [shipTo, setShipTo] = useState('');
  const [memo, setMemo] = useState('');
  const [vendorMessage, setVendorMessage] = useState('');
  const [lines, setLines] = useState<FormLine[]>([emptyLine()]);

  const purchaseOrders = usePagedList<PurchaseOrderListItem>(
    ['purchase-orders'],
    '/api/v1/purchase-orders',
  );
  const vendors = useQuery({
    queryKey: ['vendors'],
    queryFn: () => api.get<{ items: Vendor[] }>('/api/v1/vendors'),
    enabled: canCreate,
  });
  const products = useQuery({
    queryKey: ['products'],
    queryFn: () => api.get<{ items: Product[] }>('/api/v1/products'),
    enabled: canCreate,
  });
  const accounts = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api.get<{ items: Account[] }>('/api/v1/accounts'),
    enabled: canCreate,
  });

  const vendorOptions = (vendors.data?.items ?? []).filter((v) => v.active);
  const productOptions = (products.data?.items ?? []).filter((p) => p.active);
  const lineAccountOptions = (accounts.data?.items ?? []).filter(
    (a) => a.active && a.systemKey === null && LINE_CATEGORIES.has(a.category),
  );

  function productById(id: string): Product | undefined {
    return productOptions.find((p) => p.id === id);
  }

  function lineIsComplete(l: FormLine): boolean {
    const qtyOk = QTY_PATTERN.test(l.quantity) && scaledParts(l.quantity).n > 0n;
    const costOk = l.unitCost.trim() !== '' && PRICE_PATTERN.test(l.unitCost.trim());
    const selectedProduct = l.productId !== '' ? productById(l.productId) : undefined;
    const accountOk =
      l.accountId !== '' ||
      (selectedProduct !== undefined && selectedProduct.expenseAccountId !== null);
    return qtyOk && costOk && accountOk;
  }

  // ----- totals (exact decimal string math) -----
  const totalCents = lines.reduce(
    (sum, l) => sum + (lineIsComplete(l) ? lineAmountCents(l.quantity, l.unitCost) : 0n),
    0n,
  );

  const canSave =
    vendorId !== '' && poDate !== '' && lines.length >= 1 && lines.every(lineIsComplete);

  function resetForm() {
    setVendorId('');
    setPoDate(todayISO());
    setExpectedDate('');
    setShipTo('');
    setMemo('');
    setVendorMessage('');
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
    const p = productById(productId);
    if (!p) return;
    const defaultAccountId =
      p.expenseAccountId !== null && lineAccountOptions.some((a) => a.id === p.expenseAccountId)
        ? p.expenseAccountId
        : '';
    updateLine(key, {
      productId,
      description: p.name,
      unitCost:
        p.purchaseCost !== null && p.purchaseCost !== ''
          ? centsToDecimalString(toCents(p.purchaseCost))
          : '',
      accountId: defaultAccountId,
    });
  }

  const createPo = useMutation({
    mutationFn: () => {
      const payload: {
        vendorId: string;
        poDate: string;
        expectedDate?: string;
        shipTo?: string;
        memo?: string;
        vendorMessage?: string;
        lines: {
          productId?: string;
          accountId?: string;
          description?: string;
          quantity: string;
          unitCost: string;
        }[];
      } = {
        vendorId,
        poDate,
        lines: lines.map((l) => ({
          productId: l.productId !== '' ? l.productId : undefined,
          accountId: l.accountId !== '' ? l.accountId : undefined,
          description: l.description.trim() !== '' ? l.description.trim() : undefined,
          quantity: l.quantity.trim(),
          unitCost: centsToDecimalString(toCents(l.unitCost)),
        })),
      };
      if (expectedDate !== '') payload.expectedDate = expectedDate;
      if (shipTo.trim() !== '') payload.shipTo = shipTo.trim();
      if (memo.trim() !== '') payload.memo = memo.trim();
      if (vendorMessage.trim() !== '') payload.vendorMessage = vendorMessage.trim();
      return api.post<{ id: string; number: string }>('/api/v1/purchase-orders', payload);
    },
    onSuccess: (data) => {
      toast('success', `Purchase order ${data.number} created`);
      void qc.invalidateQueries({ queryKey: ['purchase-orders'] });
      setFormOpen(false);
      resetForm();
      navigate(`/expenses/purchase-orders/${data.id}`);
    },
  });

  const poItems = purchaseOrders.items;
  const listTotalCents = poItems.reduce((sum, po) => sum + toCents(po.total), 0n);

  if (purchaseOrders.isLoading) return <Spinner label="Loading purchase orders" />;
  if (purchaseOrders.error) return <ErrorNote error={purchaseOrders.error} />;

  return (
    <div>
      <PageHeader
        title="Purchase orders"
        description="Commit to vendor purchases before billing. Purchase orders never post to the ledger; converting to a bill records the payable."
        actions={
          canCreate ? (
            <Button
              onClick={() => {
                createPo.reset();
                resetForm();
                setFormOpen(true);
              }}
            >
              New purchase order
            </Button>
          ) : undefined
        }
      />

      {poItems.length === 0 ? (
        <EmptyState
          title="No purchase orders yet"
          description="Create a purchase order to track goods and services you have committed to buy."
          action={
            canCreate ? (
              <Button
                onClick={() => {
                  createPo.reset();
                  resetForm();
                  setFormOpen(true);
                }}
              >
                New purchase order
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Number</TH>
              <TH>Vendor</TH>
              <TH>Date</TH>
              <TH>Expected</TH>
              <TH>Status</TH>
              <TH className="text-right">Total</TH>
            </TR>
          </THead>
          <TBody>
            {poItems.map((po) => {
              const badge = statusBadge(po.status);
              return (
                <TR
                  key={po.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/expenses/purchase-orders/${po.id}`)}
                >
                  <TD>
                    <button
                      type="button"
                      className="text-left font-mono text-[13px] font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        navigate(`/expenses/purchase-orders/${po.id}`);
                      }}
                    >
                      {po.number}
                    </button>
                  </TD>
                  <TD>{po.vendorName}</TD>
                  <TD className="text-muted-foreground">{formatDate(po.poDate)}</TD>
                  <TD className="text-muted-foreground">{formatDate(po.expectedDate)}</TD>
                  <TD>
                    <Badge tone={badge.tone}>{badge.label}</Badge>
                  </TD>
                  <TDMoney>{formatMoney(po.total, currency)}</TDMoney>
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
                Totals ({poItems.length} {poItems.length === 1 ? 'order' : 'orders'})
              </TD>
              <TDMoney>{formatMoney(centsToDecimalString(listTotalCents), currency)}</TDMoney>
            </TR>
          </TFoot>
        </Table>
      )}
      <LoadMoreButton
        hasMore={purchaseOrders.hasMore}
        loading={purchaseOrders.isLoadingMore}
        onClick={purchaseOrders.loadMore}
      />

      {/* ----- new purchase order dialog ----- */}
      <Dialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) resetForm();
        }}
        title="New purchase order"
        description="Saved as a draft; open the purchase order to send it to the vendor, then convert it to a bill when goods arrive."
        wide
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            createPo.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="po-vendor">Vendor</Label>
              <Select
                id="po-vendor"
                required
                value={vendorId}
                onChange={(e) => setVendorId(e.target.value)}
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
              <Label htmlFor="po-date">PO date</Label>
              <Input
                id="po-date"
                type="date"
                required
                value={poDate}
                onChange={(e) => setPoDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="po-expected">Expected date (optional)</Label>
              <Input
                id="po-expected"
                type="date"
                value={expectedDate}
                onChange={(e) => setExpectedDate(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="po-ship-to">Ship to (optional)</Label>
            <Textarea
              id="po-ship-to"
              className="min-h-[36px]"
              rows={1}
              value={shipTo}
              onChange={(e) => setShipTo(e.target.value)}
            />
          </div>

          <Table>
            <THead>
              <TR>
                <TH className="w-40">Product</TH>
                <TH className="w-56">Account</TH>
                <TH>Description</TH>
                <TH className="w-24 text-right">Qty</TH>
                <TH className="w-28 text-right">Unit cost</TH>
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
                    <Select
                      aria-label={`Account for line ${idx + 1}`}
                      value={l.accountId}
                      onChange={(e) => updateLine(l.key, { accountId: e.target.value })}
                    >
                      <option value="">
                        {l.productId !== '' && productById(l.productId)?.expenseAccountId
                          ? 'Product default'
                          : 'Select an account…'}
                      </option>
                      {lineAccountOptions.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.number ? `${a.number} · ${a.name}` : a.name}
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
                      aria-label={`Unit cost for line ${idx + 1}`}
                      placeholder="0.00"
                      value={l.unitCost}
                      onChange={(e) => {
                        if (PRICE_PATTERN.test(e.target.value)) {
                          updateLine(l.key, { unitCost: e.target.value });
                        }
                      }}
                    />
                  </TD>
                  <TDMoney>
                    {lineIsComplete(l)
                      ? formatMoney(
                          centsToDecimalString(lineAmountCents(l.quantity, l.unitCost)),
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

          <div>
            <Button variant="outline" onClick={() => setLines((prev) => [...prev, emptyLine()])}>
              Add line
            </Button>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="po-vendor-message">Vendor message (optional)</Label>
              <Textarea
                id="po-vendor-message"
                value={vendorMessage}
                onChange={(e) => setVendorMessage(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="po-memo">Memo (optional)</Label>
              <Textarea id="po-memo" value={memo} onChange={(e) => setMemo(e.target.value)} />
            </div>
          </div>

          {createPo.error ? <ErrorNote error={createPo.error} /> : null}

          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {!canSave
                ? 'A vendor, a PO date, and at least one line with a positive quantity, a unit cost, and an account (or a product with an expense account) are required.'
                : 'Ready to save.'}
            </p>
            <Button type="submit" disabled={!canSave} loading={createPo.isPending}>
              Create purchase order
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
