import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import type { Me } from '@/lib/types';
import { can } from '@/lib/types';
import { formatDate, formatMoney, formatQuantity, todayISO } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input, MoneyInput, Textarea } from '@/components/ui/input';
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
  Select,
  Spinner,
} from '@/components/ui/primitives';
import { Table, TBody, TD, TDMoney, TFoot, TH, THead, TR } from '@/components/ui/table';

type PostingStatus = 'draft' | 'posted' | 'voided' | 'reversed';
type SettlementStatus = null | 'open' | 'partially_paid' | 'paid';

interface InvoiceLine {
  id: string;
  lineNumber: number;
  productId: string | null;
  description: string | null;
  quantity: string;
  unitPrice: string;
  amount: string;
  taxable: boolean;
}

interface PaymentAllocation {
  id: string;
  paymentId: string;
  paymentNumber: string;
  amount: string;
  effectiveDate: string;
  reversalOfAllocationId: string | null;
}

interface CreditAllocation {
  id: string;
  creditMemoId?: string | null;
  creditMemoNumber?: string | null;
  amount: string;
  effectiveDate: string;
  reversalOfAllocationId?: string | null;
}

interface InvoiceDetail {
  id: string;
  number: string;
  customerId: string;
  customerName: string;
  postingStatus: PostingStatus;
  settlementStatus: SettlementStatus;
  invoiceDate: string;
  dueDate: string | null;
  termsDays?: number | null;
  memo: string | null;
  customerMessage: string | null;
  taxRateId: string | null;
  subtotal: string;
  taxTotal: string;
  total: string;
  openBalance: string;
  lines: InvoiceLine[];
  paymentAllocations: PaymentAllocation[];
  creditAllocations: CreditAllocation[];
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

interface AccountItem {
  id: string;
  number: string | null;
  name: string;
  category: string;
  detailType: string | null;
  systemKey: string | null;
  bankKind: string | null;
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

const PAYMENT_METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'check', label: 'Check' },
  { value: 'card', label: 'Card' },
  { value: 'ach', label: 'ACH' },
  { value: 'other', label: 'Other' },
];

// ---------------------------------------------------------------------------
// Line-editor state (edit dialog; drafts only)
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

function statusBadge(inv: InvoiceDetail): {
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

export function InvoiceDetailPage({ me }: { me: Me }) {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const { toast } = useToast();
  const currency = me.company?.homeCurrency ?? 'USD';
  const today = todayISO();

  const canPost = can(me, 'invoices.post');
  const canEditInv = can(me, 'invoices.edit');
  const canVoid = can(me, 'invoices.void');
  const canReceive = can(me, 'customer_payments.create');
  const canUnapply = can(me, 'customer_payments.edit');

  // ----- edit dialog state -----
  const [editOpen, setEditOpen] = useState(false);
  const [customerId, setCustomerId] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(todayISO());
  const [termsDays, setTermsDays] = useState('30');
  const [taxRateId, setTaxRateId] = useState('');
  const [customerMessage, setCustomerMessage] = useState('');
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<FormLine[]>([emptyLine()]);

  // ----- void dialog state -----
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [needsInventoryConfirm, setNeedsInventoryConfirm] = useState(false);
  const [confirmReturn, setConfirmReturn] = useState(false);

  // ----- write-off dialog state -----
  const [writeOffOpen, setWriteOffOpen] = useState(false);
  const [woAmount, setWoAmount] = useState('');
  const [woDate, setWoDate] = useState(todayISO());
  const [woReason, setWoReason] = useState('');

  // ----- receive payment dialog state -----
  const [payOpen, setPayOpen] = useState(false);
  const [payAmount, setPayAmount] = useState('');
  const [payDate, setPayDate] = useState(todayISO());
  const [depositToAccountId, setDepositToAccountId] = useState('');
  const [payMethod, setPayMethod] = useState('check');
  const [payReference, setPayReference] = useState('');

  const invoice = useQuery({
    queryKey: ['invoice', id],
    queryFn: () => api.get<InvoiceDetail>(`/api/v1/invoices/${id}`),
    enabled: Boolean(id),
  });
  const customers = useQuery({
    queryKey: ['customers'],
    queryFn: () => api.get<{ items: Customer[] }>('/api/v1/customers'),
    enabled: canEditInv,
  });
  const products = useQuery({
    queryKey: ['products'],
    queryFn: () => api.get<{ items: Product[] }>('/api/v1/products'),
    enabled: canEditInv,
  });
  const taxRates = useQuery({
    queryKey: ['tax-rates'],
    queryFn: () => api.get<{ items: TaxRate[] }>('/api/v1/tax-rates'),
    enabled: canEditInv,
  });
  const accounts = useQuery({
    queryKey: ['accounts', { withBalances: true }],
    queryFn: () => api.get<{ items: AccountItem[] }>('/api/v1/accounts?withBalances=true'),
    enabled: canReceive,
  });

  const customerOptions = (customers.data?.items ?? []).filter((c) => c.active);
  const productOptions = (products.data?.items ?? []).filter((p) => p.active);
  const taxRateOptions = (taxRates.data?.items ?? []).filter((t) => t.active);
  const selectedTaxRate = taxRateOptions.find((t) => t.id === taxRateId) ?? null;
  const depositAccountOptions = (accounts.data?.items ?? []).filter(
    (a) => a.active && (a.bankKind === 'bank' || a.systemKey === 'undeposited_funds'),
  );

  function invalidateInvoice() {
    void qc.invalidateQueries({ queryKey: ['invoice', id] });
    void qc.invalidateQueries({ queryKey: ['invoices'] });
  }

  const postInvoice = useMutation({
    mutationFn: () =>
      api.post<{ journalEntryId: string }>(`/api/v1/invoices/${id}/post`, {
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: () => {
      toast('success', 'Invoice posted');
      invalidateInvoice();
      void qc.invalidateQueries({ queryKey: ['accounts'] });
    },
    onError: (err) => toast('error', err instanceof Error ? err.message : 'Post failed'),
  });

  const updateInvoice = useMutation({
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
      return api.patch<{ ok: boolean }>(`/api/v1/invoices/${id}`, payload);
    },
    onSuccess: () => {
      toast('success', 'Invoice updated');
      invalidateInvoice();
      setEditOpen(false);
    },
  });

  const voidInvoice = useMutation({
    mutationFn: () =>
      api.post<{ reversalEntryId: string }>(`/api/v1/invoices/${id}/void`, {
        idempotencyKey: crypto.randomUUID(),
        reason: voidReason.trim(),
        ...(confirmReturn ? { confirmInventoryReturn: true } : {}),
      }),
    onSuccess: () => {
      toast('success', 'Invoice voided');
      invalidateInvoice();
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      setVoidOpen(false);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'INVENTORY_RETURN_CONFIRMATION_REQUIRED') {
        setNeedsInventoryConfirm(true);
      }
    },
  });

  const writeOff = useMutation({
    mutationFn: () =>
      api.post<{ journalEntryId: string }>(`/api/v1/invoices/${id}/write-off`, {
        idempotencyKey: crypto.randomUUID(),
        amount: centsToDecimalString(toCents(woAmount)),
        date: woDate,
        reason: woReason.trim(),
      }),
    onSuccess: () => {
      toast('success', 'Balance written off');
      invalidateInvoice();
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      setWriteOffOpen(false);
    },
  });

  const receivePayment = useMutation({
    mutationFn: () => {
      const inv = invoice.data;
      if (!inv) throw new Error('Invoice not loaded');
      const amount = centsToDecimalString(toCents(payAmount));
      return api.post<{ id: string; number: string }>('/api/v1/payments', {
        customerId: inv.customerId,
        paymentDate: payDate,
        amount,
        depositToAccountId,
        method: payMethod !== '' ? payMethod : undefined,
        reference: payReference.trim() !== '' ? payReference.trim() : undefined,
        allocations: [{ invoiceId: inv.id, amount }],
        idempotencyKey: crypto.randomUUID(),
      });
    },
    onSuccess: (data) => {
      toast('success', `Payment ${data.number} recorded`);
      invalidateInvoice();
      void qc.invalidateQueries({ queryKey: ['payments'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      void qc.invalidateQueries({ queryKey: ['undeposited-receipts'] });
      setPayOpen(false);
    },
  });

  const unapply = useMutation({
    mutationFn: (allocationId: string) =>
      api.post<{ ok: boolean }>(`/api/v1/payment-allocations/${allocationId}/unapply`, {
        effectiveDate: todayISO(),
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: () => {
      toast('success', 'Payment application reversed');
      invalidateInvoice();
      void qc.invalidateQueries({ queryKey: ['payments'] });
    },
    onError: (err) => toast('error', err instanceof Error ? err.message : 'Unapply failed'),
  });

  if (invoice.isLoading) return <Spinner label="Loading invoice" />;
  if (invoice.error) return <ErrorNote error={invoice.error} />;
  const inv = invoice.data;
  if (!inv) return <ErrorNote error={new Error('Invoice not found')} />;

  const badge = statusBadge(inv);
  const openCents = toCents(inv.openBalance);
  const overdue =
    inv.postingStatus === 'posted' && openCents > 0n && inv.dueDate !== null && inv.dueDate < today;

  const isDraft = inv.postingStatus === 'draft';
  const isPosted = inv.postingStatus === 'posted';

  // An allocation is active when it is not itself a reversal and no later
  // reversal row points back at it.
  const reversedIds = new Set(
    inv.paymentAllocations
      .map((a) => a.reversalOfAllocationId)
      .filter((x): x is string => x !== null),
  );
  const allocationIsActive = (a: PaymentAllocation) =>
    a.reversalOfAllocationId === null && !reversedIds.has(a.id);

  // ----- edit form derived values -----
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
  const canSaveEdit =
    customerId !== '' &&
    invoiceDate !== '' &&
    termsValid &&
    lines.length >= 1 &&
    lines.every(lineIsComplete);

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

  function openEdit(detail: InvoiceDetail) {
    updateInvoice.reset();
    setCustomerId(detail.customerId);
    setInvoiceDate(detail.invoiceDate);
    setTermsDays(
      detail.termsDays !== null && detail.termsDays !== undefined ? String(detail.termsDays) : '30',
    );
    setTaxRateId(detail.taxRateId ?? '');
    setCustomerMessage(detail.customerMessage ?? '');
    setMemo(detail.memo ?? '');
    setLines(
      detail.lines.map((l) => ({
        key: crypto.randomUUID(),
        productId: l.productId ?? '',
        description: l.description ?? '',
        quantity: l.quantity,
        unitPrice: centsToDecimalString(toCents(l.unitPrice)),
        taxable: l.taxable,
      })),
    );
    setEditOpen(true);
  }

  function openVoid() {
    voidInvoice.reset();
    setVoidReason('');
    setNeedsInventoryConfirm(false);
    setConfirmReturn(false);
    setVoidOpen(true);
  }

  function openWriteOff(detail: InvoiceDetail) {
    writeOff.reset();
    setWoAmount(centsToDecimalString(toCents(detail.openBalance)));
    setWoDate(todayISO());
    setWoReason('');
    setWriteOffOpen(true);
  }

  function openReceivePayment(detail: InvoiceDetail) {
    receivePayment.reset();
    setPayAmount(centsToDecimalString(toCents(detail.openBalance)));
    setPayDate(todayISO());
    const undeposited = depositAccountOptions.find((a) => a.systemKey === 'undeposited_funds');
    setDepositToAccountId(undeposited?.id ?? depositAccountOptions[0]?.id ?? '');
    setPayMethod('check');
    setPayReference('');
    setPayOpen(true);
  }

  const woAmountValid =
    PRICE_PATTERN.test(woAmount.trim()) && toCents(woAmount) > 0n && toCents(woAmount) <= openCents;
  const payAmountValid = PRICE_PATTERN.test(payAmount.trim()) && toCents(payAmount) > 0n;

  return (
    <div>
      <div className="mb-3">
        <Link
          to="/sales/invoices"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to invoices
        </Link>
      </div>

      <PageHeader
        title={`Invoice ${inv.number}`}
        description={`For ${inv.customerName}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={`/api/v1/invoices/${inv.id}/pdf`}
              download
              className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-input bg-transparent px-4 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Download PDF
            </a>
            {isDraft && canEditInv ? (
              <Button variant="outline" onClick={() => openEdit(inv)}>
                Edit
              </Button>
            ) : null}
            {isDraft && canPost ? (
              <Button loading={postInvoice.isPending} onClick={() => postInvoice.mutate()}>
                Post
              </Button>
            ) : null}
            {isPosted && openCents > 0n && canReceive ? (
              <Button onClick={() => openReceivePayment(inv)}>Receive payment</Button>
            ) : null}
            {isPosted && openCents > 0n && canVoid ? (
              <Button variant="outline" onClick={() => openWriteOff(inv)}>
                Write off
              </Button>
            ) : null}
            {isPosted && canVoid ? (
              <Button variant="outline" className="text-destructive" onClick={openVoid}>
                Void
              </Button>
            ) : null}
          </div>
        }
      />

      <Card className="mb-5">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>Details</CardTitle>
          <span className="flex flex-wrap gap-1">
            <Badge tone={badge.tone}>{badge.label}</Badge>
            {overdue ? <Badge tone="danger">Overdue</Badge> : null}
          </span>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Customer</dt>
              <dd className="mt-0.5 font-medium">{inv.customerName}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                Invoice date
              </dt>
              <dd className="mt-0.5">{formatDate(inv.invoiceDate)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Due date</dt>
              <dd className="mt-0.5">{formatDate(inv.dueDate)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Totals</dt>
              <dd className="mt-0.5 space-y-0.5">
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span data-money className="font-mono tabular-nums">
                    {formatMoney(inv.subtotal, currency)}
                  </span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Tax</span>
                  <span data-money className="font-mono tabular-nums">
                    {formatMoney(inv.taxTotal, currency)}
                  </span>
                </div>
                <div className="flex justify-between gap-4 font-semibold">
                  <span>Total</span>
                  <span data-money className="font-mono tabular-nums">
                    {formatMoney(inv.total, currency)}
                  </span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Open balance</span>
                  <span data-money className="font-mono tabular-nums">
                    {formatMoney(inv.openBalance, currency)}
                  </span>
                </div>
              </dd>
            </div>
            {inv.customerMessage ? (
              <div className="sm:col-span-2">
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  Customer message
                </dt>
                <dd className="mt-0.5 whitespace-pre-wrap">{inv.customerMessage}</dd>
              </div>
            ) : null}
            {inv.memo ? (
              <div className="sm:col-span-2">
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Memo</dt>
                <dd className="mt-0.5 whitespace-pre-wrap">{inv.memo}</dd>
              </div>
            ) : null}
          </dl>
        </CardContent>
      </Card>

      <Table>
        <THead>
          <TR>
            <TH className="w-12">#</TH>
            <TH>Description</TH>
            <TH className="w-24 text-right">Qty</TH>
            <TH className="w-28 text-right">Unit price</TH>
            <TH className="w-14">Tax</TH>
            <TH className="w-32 text-right">Amount</TH>
          </TR>
        </THead>
        <TBody>
          {inv.lines.map((l) => (
            <TR key={l.id}>
              <TD className="text-muted-foreground">{l.lineNumber}</TD>
              <TD>{l.description ?? '—'}</TD>
              <TD className="text-right font-mono text-[13px] tabular-nums">
                {formatQuantity(l.quantity)}
              </TD>
              <TDMoney>{formatMoney(l.unitPrice, currency)}</TDMoney>
              <TD className="text-muted-foreground">{l.taxable ? 'Yes' : 'No'}</TD>
              <TDMoney>{formatMoney(l.amount, currency)}</TDMoney>
            </TR>
          ))}
        </TBody>
      </Table>

      {/* ----- activity ----- */}
      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Payments applied</CardTitle>
          </CardHeader>
          <CardContent>
            {inv.paymentAllocations.length === 0 ? (
              <p className="text-sm text-muted-foreground">No payments applied.</p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Payment</TH>
                    <TH>Date</TH>
                    <TH className="text-right">Amount</TH>
                    <TH className="w-28">
                      <span className="sr-only">Actions</span>
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {inv.paymentAllocations.map((a) => {
                    const isReversal = a.reversalOfAllocationId !== null;
                    const active = allocationIsActive(a);
                    return (
                      <TR key={a.id} className={isReversal ? 'text-muted-foreground' : undefined}>
                        <TD className={isReversal ? 'line-through' : undefined}>
                          <span className="font-mono text-[13px]">{a.paymentNumber}</span>
                        </TD>
                        <TD
                          className={
                            isReversal
                              ? 'line-through text-muted-foreground'
                              : 'text-muted-foreground'
                          }
                        >
                          {formatDate(a.effectiveDate)}
                        </TD>
                        <TDMoney className={isReversal ? 'line-through' : undefined}>
                          {formatMoney(a.amount, currency)}
                        </TDMoney>
                        <TD>
                          {isReversal ? (
                            <Badge tone="warning">Unapplied</Badge>
                          ) : active && canUnapply ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-destructive"
                              loading={unapply.isPending && unapply.variables === a.id}
                              onClick={() => unapply.mutate(a.id)}
                            >
                              Unapply
                            </Button>
                          ) : !active ? (
                            <span className="text-xs text-muted-foreground">Reversed</span>
                          ) : null}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Credits applied</CardTitle>
          </CardHeader>
          <CardContent>
            {inv.creditAllocations.length === 0 ? (
              <p className="text-sm text-muted-foreground">No credits applied.</p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Credit memo</TH>
                    <TH>Date</TH>
                    <TH className="text-right">Amount</TH>
                  </TR>
                </THead>
                <TBody>
                  {inv.creditAllocations.map((a) => {
                    const isReversal = Boolean(a.reversalOfAllocationId);
                    return (
                      <TR key={a.id} className={isReversal ? 'text-muted-foreground' : undefined}>
                        <TD className={isReversal ? 'line-through' : undefined}>
                          <span className="flex items-center gap-2">
                            <span className="font-mono text-[13px]">
                              {a.creditMemoNumber ?? '—'}
                            </span>
                            {isReversal ? <Badge tone="warning">Unapplied</Badge> : null}
                          </span>
                        </TD>
                        <TD
                          className={
                            isReversal
                              ? 'line-through text-muted-foreground'
                              : 'text-muted-foreground'
                          }
                        >
                          {formatDate(a.effectiveDate)}
                        </TD>
                        <TDMoney className={isReversal ? 'line-through' : undefined}>
                          {formatMoney(a.amount, currency)}
                        </TDMoney>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ----- edit dialog (drafts only) ----- */}
      <Dialog
        open={editOpen}
        onOpenChange={setEditOpen}
        title={`Edit invoice ${inv.number}`}
        description="Only drafts can be edited; posting locks the invoice."
        wide
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            updateInvoice.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="edit-customer">Customer</Label>
              <Select
                id="edit-customer"
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
              <Label htmlFor="edit-date">Invoice date</Label>
              <Input
                id="edit-date"
                type="date"
                required
                value={invoiceDate}
                onChange={(e) => setInvoiceDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-terms">Terms (days)</Label>
              <Input
                id="edit-terms"
                inputMode="numeric"
                required
                value={termsDays}
                onChange={(e) => {
                  if (e.target.value === '' || TERMS_PATTERN.test(e.target.value)) {
                    setTermsDays(e.target.value);
                  }
                }}
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
              <Label htmlFor="edit-tax-rate">Tax rate (optional)</Label>
              <Select
                id="edit-tax-rate"
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
              <Label htmlFor="edit-message">Customer message (optional)</Label>
              <Textarea
                id="edit-message"
                value={customerMessage}
                onChange={(e) => setCustomerMessage(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-memo">Memo (optional)</Label>
              <Textarea id="edit-memo" value={memo} onChange={(e) => setMemo(e.target.value)} />
            </div>
          </div>

          {updateInvoice.error ? <ErrorNote error={updateInvoice.error} /> : null}

          <div className="flex justify-end">
            <Button type="submit" disabled={!canSaveEdit} loading={updateInvoice.isPending}>
              Save changes
            </Button>
          </div>
        </form>
      </Dialog>

      {/* ----- void dialog ----- */}
      <Dialog
        open={voidOpen}
        onOpenChange={setVoidOpen}
        title={`Void invoice ${inv.number}`}
        description="Posts a reversal entry that cancels this invoice in the ledger. The original entry is never altered."
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            voidInvoice.mutate();
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
          {needsInventoryConfirm ? (
            <label
              className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
              htmlFor="void-confirm-return"
            >
              <input
                id="void-confirm-return"
                type="checkbox"
                className="h-4 w-4 rounded border-input"
                checked={confirmReturn}
                onChange={(e) => setConfirmReturn(e.target.checked)}
              />
              Goods physically returned to stock
            </label>
          ) : null}
          {voidInvoice.error ? <ErrorNote error={voidInvoice.error} /> : null}
          <Button
            type="submit"
            variant="destructive"
            className="w-full"
            disabled={voidReason.trim() === '' || (needsInventoryConfirm && !confirmReturn)}
            loading={voidInvoice.isPending}
          >
            Void invoice
          </Button>
        </form>
      </Dialog>

      {/* ----- write-off dialog ----- */}
      <Dialog
        open={writeOffOpen}
        onOpenChange={setWriteOffOpen}
        title={`Write off invoice ${inv.number}`}
        description="Moves the unpaid balance to bad debt expense with a journal entry."
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            writeOff.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="wo-amount">Amount</Label>
              <MoneyInput
                id="wo-amount"
                required
                placeholder="0.00"
                value={woAmount}
                onChange={(e) => {
                  if (PRICE_PATTERN.test(e.target.value)) setWoAmount(e.target.value);
                }}
              />
              <p className="text-xs text-muted-foreground">
                Open balance: {formatMoney(inv.openBalance, currency)}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wo-date">Date</Label>
              <Input
                id="wo-date"
                type="date"
                required
                value={woDate}
                onChange={(e) => setWoDate(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wo-reason">Reason</Label>
            <Textarea
              id="wo-reason"
              required
              value={woReason}
              onChange={(e) => setWoReason(e.target.value)}
            />
          </div>
          {writeOff.error ? <ErrorNote error={writeOff.error} /> : null}
          <Button
            type="submit"
            className="w-full"
            disabled={!woAmountValid || woDate === '' || woReason.trim() === ''}
            loading={writeOff.isPending}
          >
            Write off balance
          </Button>
        </form>
      </Dialog>

      {/* ----- receive payment dialog ----- */}
      <Dialog
        open={payOpen}
        onOpenChange={setPayOpen}
        title={`Receive payment for ${inv.number}`}
        description="Records a customer payment applied to this invoice."
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            receivePayment.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
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
              <p className="text-xs text-muted-foreground">
                Open balance: {formatMoney(inv.openBalance, currency)}
              </p>
            </div>
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
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pay-deposit-to">Deposit to</Label>
            <Select
              id="pay-deposit-to"
              required
              value={depositToAccountId}
              onChange={(e) => setDepositToAccountId(e.target.value)}
            >
              <option value="" disabled>
                Select an account…
              </option>
              {depositAccountOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.number ? `${a.number} · ${a.name}` : a.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="pay-method">Method</Label>
              <Select
                id="pay-method"
                value={payMethod}
                onChange={(e) => setPayMethod(e.target.value)}
              >
                {PAYMENT_METHODS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pay-reference">Reference (optional)</Label>
              <Input
                id="pay-reference"
                value={payReference}
                onChange={(e) => setPayReference(e.target.value)}
              />
            </div>
          </div>
          {receivePayment.error ? <ErrorNote error={receivePayment.error} /> : null}
          <Button
            type="submit"
            className="w-full"
            disabled={!payAmountValid || payDate === '' || depositToAccountId === ''}
            loading={receivePayment.isPending}
          >
            Record payment
          </Button>
        </form>
      </Dialog>
    </div>
  );
}
