import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import type { Me } from '@/lib/types';
import { can } from '@/lib/types';
import { formatDate, formatMoney, todayISO } from '@/lib/utils';
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
type ApprovalStatus = 'not_required' | 'pending' | 'partially_approved' | 'approved' | 'rejected';

interface BillLine {
  id: string;
  lineNumber: number;
  accountId: string | null;
  productId: string | null;
  description: string | null;
  quantity: string | null;
  unitCost: string | null;
  amount: string;
}

interface BillApproval {
  id: string;
  step: number;
  decision: 'approved' | 'rejected';
  decidedByUserId: string;
  decidedByName: string | null;
  decidedAt: string;
  reason: string | null;
}

interface BillPaymentAllocation {
  id: string;
  billPaymentId: string;
  paymentNumber: string;
  amount: string;
  effectiveDate: string;
}

interface BillDetail {
  id: string;
  number: string;
  vendorId: string;
  postingStatus: PostingStatus;
  approvalStatus: ApprovalStatus;
  billDate: string;
  dueDate: string | null;
  termsDays: number | null;
  vendorReference: string | null;
  memo: string | null;
  rejectionReason: string | null;
  total: string;
  openBalance: string;
  lines: BillLine[];
  paymentAllocations: BillPaymentAllocation[];
  approvals: BillApproval[];
}

interface Vendor {
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
  bankKind: 'bank' | 'credit_card' | null;
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

const PRICE_PATTERN = /^\d*(\.\d{0,2})?$/;

const PAYMENT_METHODS = [
  { value: 'check', label: 'Check' },
  { value: 'ach', label: 'ACH' },
  { value: 'card', label: 'Card' },
  { value: 'cash', label: 'Cash' },
  { value: 'other', label: 'Other' },
];

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

function statusBadge(bill: BillDetail): {
  label: string;
  tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
} {
  if (bill.postingStatus === 'draft') return { label: 'Draft', tone: 'neutral' };
  if (bill.postingStatus === 'voided') return { label: 'Voided', tone: 'danger' };
  if (bill.postingStatus === 'reversed') return { label: 'Reversed', tone: 'danger' };
  const open = toCents(bill.openBalance);
  if (open <= 0n) return { label: 'Paid', tone: 'success' };
  if (open < toCents(bill.total)) return { label: 'Partially paid', tone: 'warning' };
  return { label: 'Open', tone: 'info' };
}

function approvalBadge(status: ApprovalStatus): {
  label: string;
  tone: 'warning' | 'success' | 'danger';
} | null {
  if (status === 'pending') return { label: 'Approval pending', tone: 'warning' };
  if (status === 'partially_approved') return { label: '1 of 2 approvals', tone: 'warning' };
  if (status === 'approved') return { label: 'Approved', tone: 'success' };
  if (status === 'rejected') return { label: 'Rejected', tone: 'danger' };
  return null;
}

export function BillDetailPage({ me }: { me: Me }) {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const { toast } = useToast();
  const currency = me.company?.homeCurrency ?? 'USD';
  const today = todayISO();

  const canApprove = can(me, 'bills.approve');
  const canPost = can(me, 'bills.post');
  const canVoid = can(me, 'bills.void');
  const canPay = can(me, 'bill_payments.pay');

  // ----- reject dialog state -----
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  // ----- void dialog state -----
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');

  // ----- pay dialog state -----
  const [payOpen, setPayOpen] = useState(false);
  const [payDate, setPayDate] = useState(todayISO());
  const [payBankAccountId, setPayBankAccountId] = useState('');
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('check');
  const [payReference, setPayReference] = useState('');

  const bill = useQuery({
    queryKey: ['bill', id],
    queryFn: () => api.get<BillDetail>(`/api/v1/bills/${id}`),
    enabled: Boolean(id),
  });
  const vendors = useQuery({
    queryKey: ['vendors'],
    queryFn: () => api.get<{ items: Vendor[] }>('/api/v1/vendors?includeInactive=true'),
  });
  const accounts = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api.get<{ items: Account[] }>('/api/v1/accounts'),
  });

  const accountItems = accounts.data?.items ?? [];
  const accountLabelById = new Map(
    accountItems.map((a) => [a.id, a.number ? `${a.number} · ${a.name}` : a.name] as const),
  );
  const bankAccountOptions = accountItems.filter((a) => a.active && a.bankKind === 'bank');

  function invalidateBill() {
    void qc.invalidateQueries({ queryKey: ['bill', id] });
    void qc.invalidateQueries({ queryKey: ['bills'] });
  }

  const approveBill = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; approvalStatus: ApprovalStatus }>(`/api/v1/bills/${id}/approve`, {}),
    onSuccess: (data) => {
      toast(
        'success',
        data.approvalStatus === 'partially_approved'
          ? 'Approval recorded — a second approver is required'
          : 'Bill approved',
      );
      invalidateBill();
    },
  });

  const rejectBill = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean }>(`/api/v1/bills/${id}/reject`, { reason: rejectReason.trim() }),
    onSuccess: () => {
      toast('success', 'Bill rejected');
      invalidateBill();
      setRejectOpen(false);
    },
  });

  const postBill = useMutation({
    mutationFn: () =>
      api.post<{ journalEntryId: string }>(`/api/v1/bills/${id}/post`, {
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: () => {
      toast('success', 'Bill posted');
      invalidateBill();
      void qc.invalidateQueries({ queryKey: ['accounts'] });
    },
  });

  const voidBill = useMutation({
    mutationFn: () =>
      api.post<{ reversalEntryId: string }>(`/api/v1/bills/${id}/void`, {
        idempotencyKey: crypto.randomUUID(),
        reason: voidReason.trim(),
      }),
    onSuccess: () => {
      toast('success', 'Bill voided');
      invalidateBill();
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      setVoidOpen(false);
    },
  });

  const payBill = useMutation({
    mutationFn: () => {
      const detail = bill.data;
      if (!detail) throw new Error('Bill not loaded');
      const amount = centsToDecimalString(toCents(payAmount));
      return api.post<{ id: string; number: string; amount: string }>('/api/v1/bill-payments', {
        vendorId: detail.vendorId,
        paymentDate: payDate,
        bankAccountId: payBankAccountId,
        method: payMethod !== '' ? payMethod : undefined,
        reference: payReference.trim() !== '' ? payReference.trim() : undefined,
        allocations: [{ billId: detail.id, amount }],
        idempotencyKey: crypto.randomUUID(),
      });
    },
    onSuccess: (data) => {
      toast('success', `Bill payment ${data.number} recorded`);
      invalidateBill();
      void qc.invalidateQueries({ queryKey: ['bill-payments'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      setPayOpen(false);
    },
  });

  if (bill.isLoading) return <Spinner label="Loading bill" />;
  if (bill.error) return <ErrorNote error={bill.error} />;
  const detail = bill.data;
  if (!detail) return <ErrorNote error={new Error('Bill not found')} />;

  const vendorName =
    (vendors.data?.items ?? []).find((v) => v.id === detail.vendorId)?.displayName ??
    'Unknown vendor';

  const badge = statusBadge(detail);
  const approval = approvalBadge(detail.approvalStatus);
  const openCents = toCents(detail.openBalance);
  const overdue =
    detail.postingStatus === 'posted' &&
    openCents > 0n &&
    detail.dueDate !== null &&
    detail.dueDate < today;

  const isDraft = detail.postingStatus === 'draft';
  const isPosted = detail.postingStatus === 'posted';
  const awaitingApproval =
    detail.approvalStatus === 'pending' || detail.approvalStatus === 'partially_approved';
  const isRejected = detail.approvalStatus === 'rejected';
  const postable =
    isDraft && (detail.approvalStatus === 'approved' || detail.approvalStatus === 'not_required');

  const approveForbidden =
    approveBill.error instanceof ApiError && approveBill.error.status === 403;

  function openReject() {
    rejectBill.reset();
    setRejectReason('');
    setRejectOpen(true);
  }

  function openVoid() {
    voidBill.reset();
    setVoidReason('');
    setVoidOpen(true);
  }

  function openPay() {
    payBill.reset();
    setPayDate(todayISO());
    setPayBankAccountId(bankAccountOptions[0]?.id ?? '');
    setPayAmount(centsToDecimalString(openCents));
    setPayMethod('check');
    setPayReference('');
    setPayOpen(true);
  }

  const payAmountCents = PRICE_PATTERN.test(payAmount.trim()) ? toCents(payAmount) : 0n;
  const canSavePay =
    payDate !== '' && payBankAccountId !== '' && payAmountCents > 0n && payAmountCents <= openCents;

  return (
    <div>
      <div className="mb-3">
        <Link
          to="/expenses/bills"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to bills
        </Link>
      </div>

      <PageHeader
        title={`Bill ${detail.number}`}
        description={`From ${vendorName}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {isDraft && awaitingApproval && canApprove ? (
              <>
                <Button loading={approveBill.isPending} onClick={() => approveBill.mutate()}>
                  Approve
                </Button>
                <Button variant="outline" className="text-destructive" onClick={openReject}>
                  Reject
                </Button>
              </>
            ) : null}
            {postable && canPost ? (
              <Button loading={postBill.isPending} onClick={() => postBill.mutate()}>
                Post
              </Button>
            ) : null}
            {isPosted && openCents > 0n && canPay ? <Button onClick={openPay}>Pay</Button> : null}
            {isPosted && canVoid ? (
              <Button variant="outline" className="text-destructive" onClick={openVoid}>
                Void
              </Button>
            ) : null}
          </div>
        }
      />

      {approveBill.error ? (
        <div className="mb-4 space-y-2">
          <ApiErrorNote error={approveBill.error} />
          {approveForbidden ? (
            <p className="text-sm text-muted-foreground">
              Separation of duties: the person who created a bill cannot approve it, and the same
              approver cannot approve it twice. Ask another approver to review this bill.
            </p>
          ) : null}
        </div>
      ) : null}

      {postBill.error ? (
        <div className="mb-4">
          <ApiErrorNote error={postBill.error} />
        </div>
      ) : null}

      {isRejected && detail.rejectionReason ? (
        <div
          role="alert"
          className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <span className="font-semibold">Rejected:</span> {detail.rejectionReason}
        </div>
      ) : null}

      <Card className="mb-5">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>Details</CardTitle>
          <span className="flex flex-wrap gap-1">
            {approval ? <Badge tone={approval.tone}>{approval.label}</Badge> : null}
            <Badge tone={badge.tone}>{badge.label}</Badge>
            {overdue ? <Badge tone="danger">Overdue</Badge> : null}
          </span>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Vendor</dt>
              <dd className="mt-0.5 font-medium">{vendorName}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Bill date</dt>
              <dd className="mt-0.5">{formatDate(detail.billDate)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Due date</dt>
              <dd className="mt-0.5">{formatDate(detail.dueDate)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                Vendor reference
              </dt>
              <dd className="mt-0.5">{detail.vendorReference ?? '—'}</dd>
            </div>
            <div className="sm:col-span-2 lg:col-span-1 lg:col-start-4">
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Totals</dt>
              <dd className="mt-0.5 space-y-0.5">
                <div className="flex justify-between gap-4 font-semibold">
                  <span>Total</span>
                  <span data-money className="font-mono tabular-nums">
                    {formatMoney(detail.total, currency)}
                  </span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Open balance</span>
                  <span data-money className="font-mono tabular-nums">
                    {formatMoney(detail.openBalance, currency)}
                  </span>
                </div>
              </dd>
            </div>
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
            <TH>Account</TH>
            <TH>Description</TH>
            <TH className="w-32 text-right">Amount</TH>
          </TR>
        </THead>
        <TBody>
          {detail.lines.map((l) => (
            <TR key={l.id}>
              <TD className="text-muted-foreground">{l.lineNumber}</TD>
              <TD>{l.accountId ? (accountLabelById.get(l.accountId) ?? '—') : '—'}</TD>
              <TD>{l.description !== null && l.description !== '' ? l.description : '—'}</TD>
              <TDMoney>{formatMoney(l.amount, currency)}</TDMoney>
            </TR>
          ))}
        </TBody>
        <TFoot>
          <TR>
            <TD colSpan={3} className="text-right text-xs font-semibold uppercase tracking-wide">
              Total
            </TD>
            <TDMoney className="font-semibold">{formatMoney(detail.total, currency)}</TDMoney>
          </TR>
          <TR>
            <TD
              colSpan={3}
              className="text-right text-xs uppercase tracking-wide text-muted-foreground"
            >
              Open balance
            </TD>
            <TDMoney>{formatMoney(detail.openBalance, currency)}</TDMoney>
          </TR>
        </TFoot>
      </Table>

      {detail.approvals.length > 0 ? (
        <Card className="mt-5">
          <CardHeader>
            <CardTitle>Approval history</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <THead>
                <TR>
                  <TH className="w-16">Step</TH>
                  <TH>Decision</TH>
                  <TH>Decided by</TH>
                  <TH>Date</TH>
                  <TH>Reason</TH>
                </TR>
              </THead>
              <TBody>
                {detail.approvals.map((a) => (
                  <TR key={a.id}>
                    <TD className="text-muted-foreground">{a.step}</TD>
                    <TD>
                      {a.decision === 'approved' ? (
                        <Badge tone="success">Approved</Badge>
                      ) : (
                        <Badge tone="danger">Rejected</Badge>
                      )}
                    </TD>
                    <TD>{a.decidedByName ?? '—'}</TD>
                    <TD className="text-muted-foreground">{formatDate(a.decidedAt)}</TD>
                    <TD>{a.reason !== null && a.reason !== '' ? a.reason : '—'}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      <Card className="mt-5">
        <CardHeader>
          <CardTitle>Payments applied</CardTitle>
        </CardHeader>
        <CardContent>
          {detail.paymentAllocations.length === 0 ? (
            <p className="text-sm text-muted-foreground">No payments applied to this bill.</p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Payment</TH>
                  <TH>Effective date</TH>
                  <TH className="text-right">Amount</TH>
                </TR>
              </THead>
              <TBody>
                {detail.paymentAllocations.map((a) => (
                  <TR key={a.id}>
                    <TD className="font-mono text-[13px]">{a.paymentNumber}</TD>
                    <TD className="text-muted-foreground">{formatDate(a.effectiveDate)}</TD>
                    <TDMoney>{formatMoney(a.amount, currency)}</TDMoney>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ----- reject dialog ----- */}
      <Dialog
        open={rejectOpen}
        onOpenChange={setRejectOpen}
        title={`Reject bill ${detail.number}`}
        description="Rejecting sends the bill back to its creator; it cannot be posted until it is resubmitted and approved."
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            rejectBill.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="reject-reason">Reason</Label>
            <Textarea
              id="reject-reason"
              required
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
          </div>
          {rejectBill.error ? <ApiErrorNote error={rejectBill.error} /> : null}
          <Button
            type="submit"
            variant="destructive"
            className="w-full"
            disabled={rejectReason.trim() === ''}
            loading={rejectBill.isPending}
          >
            Reject bill
          </Button>
        </form>
      </Dialog>

      {/* ----- void dialog ----- */}
      <Dialog
        open={voidOpen}
        onOpenChange={setVoidOpen}
        title={`Void bill ${detail.number}`}
        description="Posts a reversal entry that cancels this bill in the ledger. The original entry is never altered."
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            voidBill.mutate();
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
          {voidBill.error ? (
            <div className="space-y-2">
              <ApiErrorNote error={voidBill.error} />
              {voidBill.error instanceof ApiError &&
              voidBill.error.code === 'BILL_HAS_APPLICATIONS' ? (
                <p className="text-sm text-muted-foreground">
                  Payments or vendor credits are applied to this bill. Unapply or void them first,
                  then void the bill.
                </p>
              ) : null}
            </div>
          ) : null}
          <Button
            type="submit"
            variant="destructive"
            className="w-full"
            disabled={voidReason.trim() === ''}
            loading={voidBill.isPending}
          >
            Void bill
          </Button>
        </form>
      </Dialog>

      {/* ----- pay dialog ----- */}
      <Dialog
        open={payOpen}
        onOpenChange={setPayOpen}
        title={`Pay bill ${detail.number}`}
        description={`Records a bill payment to ${vendorName} applied to this bill.`}
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            payBill.mutate();
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
              <p
                className={
                  payAmountCents > openCents
                    ? 'text-xs text-destructive'
                    : 'text-xs text-muted-foreground'
                }
              >
                {payAmountCents > openCents
                  ? `Cannot exceed the open balance of ${formatMoney(detail.openBalance, currency)}.`
                  : `Open balance: ${formatMoney(detail.openBalance, currency)}`}
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
            <Label htmlFor="pay-bank">Pay from bank account</Label>
            <Select
              id="pay-bank"
              required
              value={payBankAccountId}
              onChange={(e) => setPayBankAccountId(e.target.value)}
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
          {payBill.error ? <ApiErrorNote error={payBill.error} /> : null}
          <Button
            type="submit"
            className="w-full"
            disabled={!canSavePay}
            loading={payBill.isPending}
          >
            Record payment
          </Button>
        </form>
      </Dialog>
    </div>
  );
}
