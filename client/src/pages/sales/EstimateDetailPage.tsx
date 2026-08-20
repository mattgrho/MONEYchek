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
import { Table, TBody, TD, TDMoney, TH, THead, TR } from '@/components/ui/table';

type EstimateStatus =
  | 'draft'
  | 'sent'
  | 'accepted'
  | 'rejected'
  | 'expired'
  | 'partially_converted'
  | 'converted'
  | 'closed';

interface EstimateLine {
  id: string;
  lineNumber: number;
  productId: string | null;
  description: string | null;
  quantity: string;
  unitPrice: string;
  amount: string;
  taxable: boolean;
  convertedQuantity: string | null;
}

interface EstimateDetail {
  id: string;
  number: string;
  customerId: string;
  customerName: string;
  status: EstimateStatus;
  estimateDate: string;
  expirationDate: string | null;
  memo: string | null;
  customerMessage: string | null;
  taxRateId: string | null;
  subtotal?: string | null;
  taxTotal?: string | null;
  total: string;
  lines: EstimateLine[];
}

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

const CLOSABLE_STATUSES: EstimateStatus[] = [
  'draft',
  'sent',
  'accepted',
  'rejected',
  'expired',
  'partially_converted',
];

const CONVERTIBLE_STATUSES: EstimateStatus[] = ['sent', 'accepted', 'partially_converted'];

// ---------------------------------------------------------------------------
// Exact decimal quantity math on strings, scaled to 4dp BigInt units.
// Floats are never involved.
// ---------------------------------------------------------------------------

function scaledParts(value: string): { n: bigint; scale: number } {
  const t = value.trim();
  if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(t)) return { n: 0n, scale: 0 };
  const negative = t.startsWith('-');
  const unsigned = negative ? t.slice(1) : t;
  const [intPart = '', decPart = ''] = unsigned.split('.');
  const n = BigInt((intPart === '' ? '0' : intPart) + decPart);
  return { n: negative ? -n : n, scale: decPart.length };
}

function roundHalfUpDiv(num: bigint, denom: bigint): bigint {
  const negative = num < 0n;
  const abs = negative ? -num : num;
  const q = abs / denom;
  const r = abs % denom;
  const rounded = r * 2n >= denom ? q + 1n : q;
  return negative ? -rounded : rounded;
}

/** Quantity as an integer number of 1/10000 units. */
function toQtyUnits(value: string | null | undefined): bigint {
  if (value === null || value === undefined || value.trim() === '') return 0n;
  const { n, scale } = scaledParts(value);
  if (scale <= 4) return n * 10n ** BigInt(4 - scale);
  return roundHalfUpDiv(n, 10n ** BigInt(scale - 4));
}

/** Formats 1/10000 units back to a decimal string with trailing zeros trimmed. */
function qtyUnitsToString(units: bigint): string {
  const negative = units < 0n;
  const abs = (negative ? -units : units).toString().padStart(5, '0');
  const intPart = abs.slice(0, -4);
  const decPart = abs.slice(-4).replace(/0+$/, '');
  return `${negative ? '-' : ''}${intPart}${decPart ? `.${decPart}` : ''}`;
}

const QTY_PATTERN = /^\d*(\.\d{0,4})?$/;

interface ConvertRow {
  estimateLineId: string;
  label: string;
  remainingUnits: bigint;
  checked: boolean;
  quantity: string;
}

export function EstimateDetailPage({ me }: { me: Me }) {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();
  const currency = me.company?.homeCurrency ?? 'USD';
  const canEdit = can(me, 'estimates.edit');
  const canCreateInvoice = can(me, 'invoices.create');

  // ----- accept dialog state -----
  const [acceptOpen, setAcceptOpen] = useState(false);
  const [acceptedByName, setAcceptedByName] = useState('');

  // ----- convert dialog state -----
  const [convertOpen, setConvertOpen] = useState(false);
  const [invoiceDate, setInvoiceDate] = useState(todayISO());
  const [convertRows, setConvertRows] = useState<ConvertRow[]>([]);

  const estimate = useQuery({
    queryKey: ['estimate', id],
    queryFn: () => api.get<EstimateDetail>(`/api/v1/estimates/${id}`),
    enabled: Boolean(id),
  });

  const transition = useMutation({
    mutationFn: (input: {
      status: 'sent' | 'accepted' | 'rejected' | 'expired' | 'closed';
      acceptedByName?: string;
      acceptedSource?: string;
      successMessage: string;
    }) =>
      api.post<{ ok: boolean }>(`/api/v1/estimates/${id}/transition`, {
        status: input.status,
        acceptedByName: input.acceptedByName,
        acceptedSource: input.acceptedSource,
      }),
    onSuccess: (_data, input) => {
      toast('success', input.successMessage);
      void qc.invalidateQueries({ queryKey: ['estimate', id] });
      void qc.invalidateQueries({ queryKey: ['estimates'] });
      setAcceptOpen(false);
    },
    onError: (err) => toast('error', err instanceof Error ? err.message : 'Transition failed'),
  });

  const convert = useMutation({
    mutationFn: () => {
      const checked = convertRows.filter((r) => r.checked);
      const everyLineFully =
        convertRows.every((r) => r.remainingUnits <= 0n || r.checked) &&
        checked.every((r) => toQtyUnits(r.quantity) === r.remainingUnits);
      const payload: {
        invoiceDate: string;
        selections?: { estimateLineId: string; quantity: string }[];
      } = { invoiceDate };
      if (!everyLineFully) {
        payload.selections = checked.map((r) => ({
          estimateLineId: r.estimateLineId,
          quantity: qtyUnitsToString(toQtyUnits(r.quantity)),
        }));
      }
      return api.post<{ invoiceId: string; invoiceNumber: string }>(
        `/api/v1/estimates/${id}/convert`,
        payload,
      );
    },
    onSuccess: (data) => {
      toast('success', `Invoice ${data.invoiceNumber} created`);
      void qc.invalidateQueries({ queryKey: ['estimate', id] });
      void qc.invalidateQueries({ queryKey: ['estimates'] });
      void qc.invalidateQueries({ queryKey: ['invoices'] });
      setConvertOpen(false);
      navigate(`/sales/invoices/${data.invoiceId}`);
    },
  });

  if (estimate.isLoading) return <Spinner label="Loading estimate" />;
  if (estimate.error) return <ErrorNote error={estimate.error} />;
  const est = estimate.data;
  if (!est) return <ErrorNote error={new Error('Estimate not found')} />;

  const showConverted = est.lines.some((l) => toQtyUnits(l.convertedQuantity) > 0n);

  const canConvert = canEdit && canCreateInvoice && CONVERTIBLE_STATUSES.includes(est.status);
  const canClose = canEdit && CLOSABLE_STATUSES.includes(est.status);

  function openAccept() {
    transition.reset();
    setAcceptedByName('');
    setAcceptOpen(true);
  }

  function openConvert(lines: EstimateLine[]) {
    convert.reset();
    setInvoiceDate(todayISO());
    setConvertRows(
      lines.map((l) => {
        const remaining = toQtyUnits(l.quantity) - toQtyUnits(l.convertedQuantity);
        return {
          estimateLineId: l.id,
          label: l.description ?? `Line ${l.lineNumber}`,
          remainingUnits: remaining,
          checked: remaining > 0n,
          quantity: remaining > 0n ? qtyUnitsToString(remaining) : '0',
        };
      }),
    );
    setConvertOpen(true);
  }

  const checkedRows = convertRows.filter((r) => r.checked);
  const convertRowsValid = checkedRows.every((r) => {
    const units = toQtyUnits(r.quantity);
    return QTY_PATTERN.test(r.quantity) && units > 0n && units <= r.remainingUnits;
  });
  const canSubmitConvert = invoiceDate !== '' && checkedRows.length > 0 && convertRowsValid;

  return (
    <div>
      <div className="mb-3">
        <Link
          to="/sales/estimates"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to estimates
        </Link>
      </div>

      <PageHeader
        title={`Estimate ${est.number}`}
        description={`For ${est.customerName}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={`/api/v1/estimates/${est.id}/pdf`}
              download
              className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-input bg-transparent px-4 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Download PDF
            </a>
            {canEdit && est.status === 'draft' ? (
              <Button
                loading={transition.isPending && transition.variables?.status === 'sent'}
                onClick={() =>
                  transition.mutate({ status: 'sent', successMessage: 'Estimate marked sent' })
                }
              >
                Mark sent
              </Button>
            ) : null}
            {canEdit && est.status === 'sent' ? (
              <>
                <Button onClick={openAccept}>Mark accepted</Button>
                <Button
                  variant="outline"
                  className="text-destructive"
                  loading={transition.isPending && transition.variables?.status === 'rejected'}
                  onClick={() =>
                    transition.mutate({
                      status: 'rejected',
                      successMessage: 'Estimate marked rejected',
                    })
                  }
                >
                  Mark rejected
                </Button>
              </>
            ) : null}
            {canConvert ? (
              <Button variant="secondary" onClick={() => openConvert(est.lines)}>
                Convert to invoice
              </Button>
            ) : null}
            {canClose ? (
              <Button
                variant="ghost"
                loading={transition.isPending && transition.variables?.status === 'closed'}
                onClick={() =>
                  transition.mutate({ status: 'closed', successMessage: 'Estimate closed' })
                }
              >
                Close
              </Button>
            ) : null}
          </div>
        }
      />

      <Card className="mb-5">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>Details</CardTitle>
          <Badge tone={STATUS_TONES[est.status]}>{STATUS_LABELS[est.status]}</Badge>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Customer</dt>
              <dd className="mt-0.5 font-medium">{est.customerName}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                Estimate date
              </dt>
              <dd className="mt-0.5">{formatDate(est.estimateDate)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Expiration</dt>
              <dd className="mt-0.5">{formatDate(est.expirationDate)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Totals</dt>
              <dd className="mt-0.5 space-y-0.5">
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span data-money className="font-mono tabular-nums">
                    {formatMoney(est.subtotal ?? null, currency)}
                  </span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Tax</span>
                  <span data-money className="font-mono tabular-nums">
                    {formatMoney(est.taxTotal ?? null, currency)}
                  </span>
                </div>
                <div className="flex justify-between gap-4 font-semibold">
                  <span>Total</span>
                  <span data-money className="font-mono tabular-nums">
                    {formatMoney(est.total, currency)}
                  </span>
                </div>
              </dd>
            </div>
            {est.customerMessage ? (
              <div className="sm:col-span-2">
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  Customer message
                </dt>
                <dd className="mt-0.5 whitespace-pre-wrap">{est.customerMessage}</dd>
              </div>
            ) : null}
            {est.memo ? (
              <div className="sm:col-span-2">
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Memo</dt>
                <dd className="mt-0.5 whitespace-pre-wrap">{est.memo}</dd>
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
            {showConverted ? <TH className="w-28 text-right">Converted</TH> : null}
            <TH className="w-28 text-right">Unit price</TH>
            <TH className="w-14">Tax</TH>
            <TH className="w-32 text-right">Amount</TH>
          </TR>
        </THead>
        <TBody>
          {est.lines.map((l) => (
            <TR key={l.id}>
              <TD className="text-muted-foreground">{l.lineNumber}</TD>
              <TD>{l.description ?? '—'}</TD>
              <TD className="text-right font-mono text-[13px] tabular-nums">
                {formatQuantity(l.quantity)}
              </TD>
              {showConverted ? (
                <TD className="text-right font-mono text-[13px] tabular-nums">
                  {toQtyUnits(l.convertedQuantity) > 0n ? formatQuantity(l.convertedQuantity) : '—'}
                </TD>
              ) : null}
              <TDMoney>{formatMoney(l.unitPrice, currency)}</TDMoney>
              <TD className="text-muted-foreground">{l.taxable ? 'Yes' : 'No'}</TD>
              <TDMoney>{formatMoney(l.amount, currency)}</TDMoney>
            </TR>
          ))}
        </TBody>
      </Table>

      {/* ----- accept dialog ----- */}
      <Dialog
        open={acceptOpen}
        onOpenChange={setAcceptOpen}
        title="Mark estimate accepted"
        description="Records who accepted this estimate. The acceptance is captured as a manual entry."
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            transition.mutate({
              status: 'accepted',
              acceptedByName: acceptedByName.trim(),
              acceptedSource: 'manual',
              successMessage: 'Estimate marked accepted',
            });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="accepted-by">Accepted by</Label>
            <Input
              id="accepted-by"
              required
              value={acceptedByName}
              onChange={(e) => setAcceptedByName(e.target.value)}
            />
          </div>
          {transition.error ? <ErrorNote error={transition.error} /> : null}
          <Button
            type="submit"
            className="w-full"
            disabled={acceptedByName.trim() === ''}
            loading={transition.isPending && transition.variables?.status === 'accepted'}
          >
            Mark accepted
          </Button>
        </form>
      </Dialog>

      {/* ----- convert dialog ----- */}
      <Dialog
        open={convertOpen}
        onOpenChange={setConvertOpen}
        title="Convert to invoice"
        description="Choose which lines and quantities to invoice. Leaving every remaining line fully selected converts the whole estimate."
        wide
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            convert.mutate();
          }}
        >
          <div className="max-w-56 space-y-1.5">
            <Label htmlFor="convert-date">Invoice date</Label>
            <Input
              id="convert-date"
              type="date"
              required
              value={invoiceDate}
              onChange={(e) => setInvoiceDate(e.target.value)}
            />
          </div>

          <Table>
            <THead>
              <TR>
                <TH className="w-12">
                  <span className="sr-only">Include line</span>
                </TH>
                <TH>Line</TH>
                <TH className="w-28 text-right">Remaining</TH>
                <TH className="w-32 text-right">Quantity to invoice</TH>
              </TR>
            </THead>
            <TBody>
              {convertRows.map((r, idx) => {
                const units = toQtyUnits(r.quantity);
                const invalid =
                  r.checked &&
                  (!QTY_PATTERN.test(r.quantity) || units <= 0n || units > r.remainingUnits);
                return (
                  <TR key={r.estimateLineId}>
                    <TD className="text-center">
                      <input
                        type="checkbox"
                        aria-label={`Include line ${idx + 1} (${r.label})`}
                        className="h-4 w-4 rounded border-input"
                        disabled={r.remainingUnits <= 0n}
                        checked={r.checked}
                        onChange={(e) =>
                          setConvertRows((prev) =>
                            prev.map((x) =>
                              x.estimateLineId === r.estimateLineId
                                ? { ...x, checked: e.target.checked }
                                : x,
                            ),
                          )
                        }
                      />
                    </TD>
                    <TD>{r.label}</TD>
                    <TD className="text-right font-mono text-[13px] tabular-nums">
                      {formatQuantity(qtyUnitsToString(r.remainingUnits))}
                    </TD>
                    <TD>
                      <MoneyInput
                        aria-label={`Quantity to invoice for line ${idx + 1}`}
                        disabled={!r.checked || r.remainingUnits <= 0n}
                        aria-invalid={invalid || undefined}
                        className={invalid ? 'border-destructive' : undefined}
                        value={r.quantity}
                        onChange={(e) => {
                          if (!QTY_PATTERN.test(e.target.value)) return;
                          setConvertRows((prev) =>
                            prev.map((x) =>
                              x.estimateLineId === r.estimateLineId
                                ? { ...x, quantity: e.target.value }
                                : x,
                            ),
                          );
                        }}
                      />
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>

          <p className="text-xs text-muted-foreground">
            {checkedRows.length === 0
              ? 'Select at least one line to convert.'
              : !convertRowsValid
                ? 'Each selected line needs a quantity above zero and no more than its remaining amount.'
                : 'Ready to convert.'}
          </p>

          {convert.error ? <ErrorNote error={convert.error} /> : null}

          <div className="flex justify-end">
            <Button type="submit" disabled={!canSubmitConvert} loading={convert.isPending}>
              Create invoice
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
