import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { api } from '@/lib/api';
import type { Me } from '@/lib/types';
import { can } from '@/lib/types';
import { formatDate, formatMoney, formatQuantity, todayISO } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input, MoneyInput } from '@/components/ui/input';
import { Dialog } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorNote,
  Label,
  PageHeader,
  Spinner,
} from '@/components/ui/primitives';
import { Table, TBody, TD, TDMoney, TFoot, TH, THead, TR } from '@/components/ui/table';

type PoStatus = 'draft' | 'open' | 'partially_billed' | 'billed' | 'closed' | 'canceled';
type BillPostingStatus = 'draft' | 'posted' | 'voided' | 'reversed';

interface PoLine {
  id: string;
  lineNumber: number;
  productId: string | null;
  accountId: string | null;
  description: string | null;
  quantity: string;
  unitCost: string;
  amount: string;
  billedQuantity: string;
}

interface LinkedBill {
  id: string;
  number: string;
  billDate: string;
  postingStatus: BillPostingStatus;
  total: string;
}

interface PurchaseOrderDetail {
  id: string;
  number: string;
  vendorId: string;
  status: PoStatus;
  poDate: string;
  expectedDate: string | null;
  shipTo: string | null;
  memo: string | null;
  vendorMessage: string | null;
  total: string;
  lines: PoLine[];
  bills: LinkedBill[];
}

interface Vendor {
  id: string;
  displayName: string;
  active: boolean;
}

interface Product {
  id: string;
  name: string;
  sku: string | null;
  active: boolean;
}

interface Account {
  id: string;
  number: string | null;
  name: string;
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

/** Quantity in ten-thousandths (4dp), rounded half-up when the input has >4dp. */
function toQuantityUnits(value: string): bigint {
  const { n, scale } = scaledParts(value);
  if (scale <= 4) return n * 10n ** BigInt(4 - scale);
  return roundHalfUpDiv(n, 10n ** BigInt(scale - 4));
}

/** 4dp quantity units back to a canonical decimal string with trailing zeros trimmed. */
function unitsToQuantityString(units: bigint): string {
  const negative = units < 0n;
  const abs = (negative ? -units : units).toString().padStart(5, '0');
  const int = abs.slice(0, -4);
  const dec = abs.slice(-4).replace(/0+$/, '');
  return `${negative ? '-' : ''}${int}${dec ? `.${dec}` : ''}`;
}

const QTY_PATTERN = /^\d*(\.\d{0,4})?$/;

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

function billStatusBadge(status: BillPostingStatus): {
  label: string;
  tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
} {
  switch (status) {
    case 'draft':
      return { label: 'Draft', tone: 'neutral' };
    case 'posted':
      return { label: 'Posted', tone: 'info' };
    case 'voided':
      return { label: 'Voided', tone: 'danger' };
    case 'reversed':
      return { label: 'Reversed', tone: 'danger' };
  }
}

// ---------------------------------------------------------------------------
// Convert-dialog line state
// ---------------------------------------------------------------------------

interface ConvertLine {
  poLineId: string;
  lineNumber: number;
  description: string;
  remainingUnits: bigint;
  quantity: string;
}

function convertLineValid(l: ConvertLine): boolean {
  if (l.quantity.trim() === '') return true; // treated as zero
  if (!QTY_PATTERN.test(l.quantity.trim())) return false;
  const units = toQuantityUnits(l.quantity);
  return units >= 0n && units <= l.remainingUnits;
}

export function PurchaseOrderDetailPage({ me }: { me: Me }) {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();
  const currency = me.company?.homeCurrency ?? 'USD';

  const canEdit = can(me, 'purchase_orders.edit');
  const canConvert = canEdit && can(me, 'bills.create');

  // ----- confirm dialog state (cancel / close) -----
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmTo, setConfirmTo] = useState<'closed' | 'canceled'>('canceled');

  // ----- convert dialog state -----
  const [convertOpen, setConvertOpen] = useState(false);
  const [billDate, setBillDate] = useState(todayISO());
  const [vendorReference, setVendorReference] = useState('');
  const [convertLines, setConvertLines] = useState<ConvertLine[]>([]);

  const po = useQuery({
    queryKey: ['purchase-order', id],
    queryFn: () => api.get<PurchaseOrderDetail>(`/api/v1/purchase-orders/${id}`),
    enabled: Boolean(id),
  });
  const vendors = useQuery({
    queryKey: ['vendors'],
    queryFn: () => api.get<{ items: Vendor[] }>('/api/v1/vendors?includeInactive=true'),
  });
  const products = useQuery({
    queryKey: ['products'],
    queryFn: () => api.get<{ items: Product[] }>('/api/v1/products'),
  });
  const accounts = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api.get<{ items: Account[] }>('/api/v1/accounts'),
  });

  const productLabelById = new Map(
    (products.data?.items ?? []).map(
      (p) => [p.id, p.sku ? `${p.name} (${p.sku})` : p.name] as const,
    ),
  );
  const accountLabelById = new Map(
    (accounts.data?.items ?? []).map(
      (a) => [a.id, a.number ? `${a.number} · ${a.name}` : a.name] as const,
    ),
  );

  function invalidatePo() {
    void qc.invalidateQueries({ queryKey: ['purchase-order', id] });
    void qc.invalidateQueries({ queryKey: ['purchase-orders'] });
  }

  const transition = useMutation({
    mutationFn: (to: 'open' | 'closed' | 'canceled') =>
      api.post<{ ok: boolean }>(`/api/v1/purchase-orders/${id}/transition`, { to }),
    onSuccess: (_data, to) => {
      toast(
        'success',
        to === 'open'
          ? 'Purchase order opened'
          : to === 'closed'
            ? 'Purchase order closed'
            : 'Purchase order canceled',
      );
      invalidatePo();
      setConfirmOpen(false);
    },
    onError: (err) => toast('error', err instanceof Error ? err.message : 'Transition failed'),
  });

  const convert = useMutation({
    mutationFn: () => {
      const payload: {
        billDate: string;
        vendorReference?: string;
        selections: { poLineId: string; quantity: string }[];
      } = {
        billDate,
        selections: convertLines
          .filter((l) => l.quantity.trim() !== '' && toQuantityUnits(l.quantity) > 0n)
          .map((l) => ({ poLineId: l.poLineId, quantity: l.quantity.trim() })),
      };
      if (vendorReference.trim() !== '') payload.vendorReference = vendorReference.trim();
      return api.post<{ billId: string; billNumber: string }>(
        `/api/v1/purchase-orders/${id}/convert`,
        payload,
      );
    },
    onSuccess: (data) => {
      toast('success', `Bill ${data.billNumber} created from this purchase order`);
      invalidatePo();
      void qc.invalidateQueries({ queryKey: ['bills'] });
      setConvertOpen(false);
      navigate(`/expenses/bills/${data.billId}`);
    },
  });

  if (po.isLoading) return <Spinner label="Loading purchase order" />;
  if (po.error) return <ErrorNote error={po.error} />;
  const detail = po.data;
  if (!detail) return <ErrorNote error={new Error('Purchase order not found')} />;

  const vendorName =
    (vendors.data?.items ?? []).find((v) => v.id === detail.vendorId)?.displayName ??
    'Unknown vendor';

  const badge = statusBadge(detail.status);
  const isDraft = detail.status === 'draft';
  const isOpen = detail.status === 'open';
  const isPartiallyBilled = detail.status === 'partially_billed';
  const convertible = isOpen || isPartiallyBilled;

  function remainingUnitsFor(line: PoLine): bigint {
    const remaining = toQuantityUnits(line.quantity) - toQuantityUnits(line.billedQuantity);
    return remaining > 0n ? remaining : 0n;
  }

  function openConfirm(to: 'closed' | 'canceled') {
    transition.reset();
    setConfirmTo(to);
    setConfirmOpen(true);
  }

  function openConvert(current: PurchaseOrderDetail) {
    convert.reset();
    setBillDate(todayISO());
    setVendorReference('');
    setConvertLines(
      current.lines.map((l) => {
        const remaining = remainingUnitsFor(l);
        return {
          poLineId: l.id,
          lineNumber: l.lineNumber,
          description: l.description ?? '',
          remainingUnits: remaining,
          quantity: remaining > 0n ? unitsToQuantityString(remaining) : '0',
        };
      }),
    );
    setConvertOpen(true);
  }

  const convertLinesValid = convertLines.every(convertLineValid);
  const convertSelectedCount = convertLines.filter(
    (l) => convertLineValid(l) && l.quantity.trim() !== '' && toQuantityUnits(l.quantity) > 0n,
  ).length;
  const canSaveConvert = billDate !== '' && convertLinesValid && convertSelectedCount > 0;

  return (
    <div>
      <div className="mb-3">
        <Link
          to="/expenses/purchase-orders"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to purchase orders
        </Link>
      </div>

      <PageHeader
        title={`Purchase order ${detail.number}`}
        description={`To ${vendorName}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={`/api/v1/purchase-orders/${detail.id}/pdf`}
              download
              className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-input bg-transparent px-4 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Download PDF
            </a>
            {convertible && canConvert ? (
              <Button onClick={() => openConvert(detail)}>Convert to bill…</Button>
            ) : null}
            {isDraft && canEdit ? (
              <Button
                loading={transition.isPending && transition.variables === 'open'}
                onClick={() => transition.mutate('open')}
              >
                Open PO
              </Button>
            ) : null}
            {(isOpen || isPartiallyBilled) && canEdit ? (
              <Button variant="outline" onClick={() => openConfirm('closed')}>
                Close PO
              </Button>
            ) : null}
            {(isDraft || isOpen) && canEdit ? (
              <Button
                variant="outline"
                className="text-destructive"
                onClick={() => openConfirm('canceled')}
              >
                Cancel PO
              </Button>
            ) : null}
          </div>
        }
      />

      {transition.error && !confirmOpen ? (
        <div className="mb-4">
          <ErrorNote error={transition.error} />
        </div>
      ) : null}

      <Card className="mb-5">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>Details</CardTitle>
          <Badge tone={badge.tone}>{badge.label}</Badge>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Vendor</dt>
              <dd className="mt-0.5 font-medium">{vendorName}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">PO date</dt>
              <dd className="mt-0.5">{formatDate(detail.poDate)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                Expected date
              </dt>
              <dd className="mt-0.5">{formatDate(detail.expectedDate)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Total</dt>
              <dd data-money className="mt-0.5 font-mono font-semibold tabular-nums">
                {formatMoney(detail.total, currency)}
              </dd>
            </div>
            {detail.shipTo ? (
              <div className="sm:col-span-2">
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Ship to</dt>
                <dd className="mt-0.5 whitespace-pre-wrap">{detail.shipTo}</dd>
              </div>
            ) : null}
            {detail.vendorMessage ? (
              <div className="sm:col-span-2">
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  Vendor message
                </dt>
                <dd className="mt-0.5 whitespace-pre-wrap">{detail.vendorMessage}</dd>
              </div>
            ) : null}
            {detail.memo ? (
              <div className="sm:col-span-2">
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Memo</dt>
                <dd className="mt-0.5 whitespace-pre-wrap">{detail.memo}</dd>
              </div>
            ) : null}
          </dl>
        </CardContent>
      </Card>

      <Table>
        <THead>
          <TR>
            <TH className="w-12">#</TH>
            <TH>Product</TH>
            <TH>Account</TH>
            <TH>Description</TH>
            <TH className="w-24 text-right">Qty</TH>
            <TH className="w-28 text-right">Unit cost</TH>
            <TH className="w-28 text-right">Billed</TH>
            <TH className="w-32 text-right">Amount</TH>
          </TR>
        </THead>
        <TBody>
          {detail.lines.map((l) => (
            <TR key={l.id}>
              <TD className="text-muted-foreground">{l.lineNumber}</TD>
              <TD>{l.productId ? (productLabelById.get(l.productId) ?? '—') : '—'}</TD>
              <TD>{l.accountId ? (accountLabelById.get(l.accountId) ?? '—') : '—'}</TD>
              <TD>{l.description !== null && l.description !== '' ? l.description : '—'}</TD>
              <TD className="text-right font-mono text-[13px] tabular-nums">
                {formatQuantity(l.quantity)}
              </TD>
              <TDMoney>{formatMoney(l.unitCost, currency)}</TDMoney>
              <TD className="text-right font-mono text-[13px] tabular-nums">
                {formatQuantity(l.billedQuantity)} of {formatQuantity(l.quantity)}
              </TD>
              <TDMoney>{formatMoney(l.amount, currency)}</TDMoney>
            </TR>
          ))}
        </TBody>
        <TFoot>
          <TR>
            <TD colSpan={7} className="text-right text-xs font-semibold uppercase tracking-wide">
              Total
            </TD>
            <TDMoney className="font-semibold">{formatMoney(detail.total, currency)}</TDMoney>
          </TR>
        </TFoot>
      </Table>

      <Card className="mt-5">
        <CardHeader>
          <CardTitle>Linked bills</CardTitle>
        </CardHeader>
        <CardContent>
          {detail.bills.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No bills have been created from this purchase order.
            </p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Number</TH>
                  <TH>Bill date</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Total</TH>
                </TR>
              </THead>
              <TBody>
                {detail.bills.map((b) => {
                  const billBadge = billStatusBadge(b.postingStatus);
                  return (
                    <TR
                      key={b.id}
                      className="cursor-pointer"
                      onClick={() => navigate(`/expenses/bills/${b.id}`)}
                    >
                      <TD>
                        <button
                          type="button"
                          className="text-left font-mono text-[13px] font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            navigate(`/expenses/bills/${b.id}`);
                          }}
                        >
                          {b.number}
                        </button>
                      </TD>
                      <TD className="text-muted-foreground">{formatDate(b.billDate)}</TD>
                      <TD>
                        <Badge tone={billBadge.tone}>{billBadge.label}</Badge>
                      </TD>
                      <TDMoney>{formatMoney(b.total, currency)}</TDMoney>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ----- confirm cancel/close dialog ----- */}
      <Dialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={
          confirmTo === 'canceled'
            ? `Cancel purchase order ${detail.number}`
            : `Close purchase order ${detail.number}`
        }
        description={
          confirmTo === 'canceled'
            ? 'Canceling ends this purchase order; it can no longer be billed. Nothing is posted to the ledger.'
            : 'Closing marks the remaining quantities as no longer expected; the purchase order can no longer be billed.'
        }
      >
        <div className="space-y-4">
          {transition.error ? <ErrorNote error={transition.error} /> : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Keep purchase order
            </Button>
            <Button
              variant={confirmTo === 'canceled' ? 'destructive' : 'default'}
              loading={transition.isPending}
              onClick={() => transition.mutate(confirmTo)}
            >
              {confirmTo === 'canceled' ? 'Cancel PO' : 'Close PO'}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* ----- convert to bill dialog ----- */}
      <Dialog
        open={convertOpen}
        onOpenChange={setConvertOpen}
        title={`Convert ${detail.number} to a bill`}
        description={`Creates a draft bill for ${vendorName} from the selected remaining quantities.`}
        wide
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            convert.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="convert-date">Bill date</Label>
              <Input
                id="convert-date"
                type="date"
                required
                value={billDate}
                onChange={(e) => setBillDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="convert-vendor-ref">Vendor reference (optional)</Label>
              <Input
                id="convert-vendor-ref"
                value={vendorReference}
                onChange={(e) => setVendorReference(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                The vendor&apos;s own invoice or bill number.
              </p>
            </div>
          </div>

          <Table>
            <THead>
              <TR>
                <TH className="w-12">#</TH>
                <TH>Description</TH>
                <TH className="w-32 text-right">Remaining</TH>
                <TH className="w-32 text-right">Qty to bill</TH>
              </TR>
            </THead>
            <TBody>
              {convertLines.map((l) => {
                const exhausted = l.remainingUnits <= 0n;
                const invalid = !convertLineValid(l);
                return (
                  <TR key={l.poLineId} className={exhausted ? 'text-muted-foreground' : undefined}>
                    <TD className="text-muted-foreground">{l.lineNumber}</TD>
                    <TD>{l.description !== '' ? l.description : '—'}</TD>
                    <TD className="text-right font-mono text-[13px] tabular-nums">
                      {unitsToQuantityString(l.remainingUnits)}
                    </TD>
                    <TD>
                      <MoneyInput
                        aria-label={`Quantity to bill for line ${l.lineNumber}`}
                        aria-invalid={invalid || undefined}
                        placeholder="0"
                        disabled={exhausted}
                        className={invalid ? 'border-destructive' : undefined}
                        value={l.quantity}
                        onChange={(e) => {
                          if (QTY_PATTERN.test(e.target.value)) {
                            setConvertLines((prev) =>
                              prev.map((x) =>
                                x.poLineId === l.poLineId ? { ...x, quantity: e.target.value } : x,
                              ),
                            );
                          }
                        }}
                      />
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>

          {convert.error ? <ErrorNote error={convert.error} /> : null}

          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {!convertLinesValid
                ? 'Each quantity must not exceed the remaining quantity for its line.'
                : convertSelectedCount === 0
                  ? 'Enter a quantity greater than zero on at least one line.'
                  : `${convertSelectedCount} ${convertSelectedCount === 1 ? 'line' : 'lines'} will be billed.`}
            </p>
            <Button type="submit" disabled={!canSaveConvert} loading={convert.isPending}>
              Create bill
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
