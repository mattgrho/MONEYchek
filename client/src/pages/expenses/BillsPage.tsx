import { useMemo, useState } from 'react';
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

type PostingStatus = 'draft' | 'posted' | 'voided' | 'reversed';
type ApprovalStatus = 'not_required' | 'pending' | 'partially_approved' | 'approved' | 'rejected';
type SettlementStatus = null | 'open' | 'partially_paid' | 'paid';

interface BillListItem {
  id: string;
  number: string;
  vendorId: string;
  vendorName: string;
  postingStatus: PostingStatus;
  approvalStatus: ApprovalStatus;
  billDate: string;
  dueDate: string | null;
  vendorReference: string | null;
  total: string;
  openBalance: string;
  settlementStatus: SettlementStatus;
}

interface Vendor {
  id: string;
  displayName: string;
  termsDays: number | null;
  defaultExpenseAccountId: string | null;
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

/** Account categories a bill line can be coded to. */
const LINE_CATEGORIES = new Set(['expense', 'cogs', 'other_expense', 'asset']);

// ---------------------------------------------------------------------------
// Status presentation
// ---------------------------------------------------------------------------

type StatusTab = 'all' | 'needs_approval' | 'unpaid' | 'paid' | 'draft';

const STATUS_TABS: { key: StatusTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'needs_approval', label: 'Needs approval' },
  { key: 'unpaid', label: 'Unpaid' },
  { key: 'paid', label: 'Paid' },
  { key: 'draft', label: 'Draft' },
];

function matchesTab(bill: BillListItem, tab: StatusTab): boolean {
  switch (tab) {
    case 'all':
      return true;
    case 'needs_approval':
      return bill.approvalStatus === 'pending' || bill.approvalStatus === 'partially_approved';
    case 'unpaid':
      return bill.postingStatus === 'posted' && toCents(bill.openBalance) > 0n;
    case 'paid':
      return bill.postingStatus === 'posted' && bill.settlementStatus === 'paid';
    case 'draft':
      return bill.postingStatus === 'draft';
  }
}

function statusBadge(bill: BillListItem): {
  label: string;
  tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
} {
  if (bill.postingStatus === 'draft') return { label: 'Draft', tone: 'neutral' };
  if (bill.postingStatus === 'voided') return { label: 'Voided', tone: 'danger' };
  if (bill.postingStatus === 'reversed') return { label: 'Reversed', tone: 'danger' };
  if (bill.settlementStatus === 'paid') return { label: 'Paid', tone: 'success' };
  if (bill.settlementStatus === 'partially_paid')
    return { label: 'Partially paid', tone: 'warning' };
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

function isOverdue(bill: BillListItem, today: string): boolean {
  return (
    bill.postingStatus === 'posted' &&
    toCents(bill.openBalance) > 0n &&
    bill.dueDate !== null &&
    bill.dueDate < today
  );
}

// ---------------------------------------------------------------------------
// Line-editor state
// ---------------------------------------------------------------------------

interface FormLine {
  key: string;
  accountId: string;
  description: string;
  amount: string;
}

function emptyLine(): FormLine {
  return { key: crypto.randomUUID(), accountId: '', description: '', amount: '' };
}

function lineIsComplete(l: FormLine): boolean {
  return (
    l.accountId !== '' &&
    l.amount.trim() !== '' &&
    PRICE_PATTERN.test(l.amount.trim()) &&
    toCents(l.amount) > 0n
  );
}

export function BillsPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();
  const currency = me.company?.homeCurrency ?? 'USD';
  const canCreate = can(me, 'bills.create');
  const today = todayISO();

  const [statusTab, setStatusTab] = useState<StatusTab>('all');

  // ----- new bill dialog state -----
  const [formOpen, setFormOpen] = useState(false);
  const [vendorId, setVendorId] = useState('');
  const [billDate, setBillDate] = useState(todayISO());
  const [termsDays, setTermsDays] = useState('30');
  const [vendorReference, setVendorReference] = useState('');
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<FormLine[]>([emptyLine()]);

  const bills = usePagedList<BillListItem>(['bills'], '/api/v1/bills');
  const vendors = useQuery({
    queryKey: ['vendors'],
    queryFn: () => api.get<{ items: Vendor[] }>('/api/v1/vendors'),
    enabled: canCreate,
  });
  const accounts = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api.get<{ items: Account[] }>('/api/v1/accounts'),
    enabled: canCreate,
  });

  const vendorOptions = (vendors.data?.items ?? []).filter((v) => v.active);
  const lineAccountOptions = (accounts.data?.items ?? []).filter(
    (a) => a.active && LINE_CATEGORIES.has(a.category),
  );

  // ----- totals (exact decimal string math) -----
  const totalCents = lines.reduce(
    (sum, l) => sum + (lineIsComplete(l) ? toCents(l.amount) : 0n),
    0n,
  );

  const termsValid = TERMS_PATTERN.test(termsDays.trim());
  const dueDatePreview =
    billDate !== '' && termsValid ? addDaysISO(billDate, Number(termsDays.trim())) : null;

  const canSave =
    vendorId !== '' &&
    billDate !== '' &&
    termsValid &&
    lines.length >= 1 &&
    lines.every(lineIsComplete);

  function resetForm() {
    setVendorId('');
    setBillDate(todayISO());
    setTermsDays('30');
    setVendorReference('');
    setMemo('');
    setLines([emptyLine()]);
  }

  function updateLine(key: string, patch: Partial<FormLine>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function selectVendor(nextId: string) {
    setVendorId(nextId);
    const v = vendorOptions.find((x) => x.id === nextId);
    if (!v) return;
    if (v.termsDays !== null && v.termsDays !== undefined) setTermsDays(String(v.termsDays));
    if (v.defaultExpenseAccountId) {
      const validDefault = lineAccountOptions.some((a) => a.id === v.defaultExpenseAccountId);
      if (validDefault) {
        setLines((prev) =>
          prev.map((l, idx) =>
            idx === 0 && l.accountId === ''
              ? { ...l, accountId: v.defaultExpenseAccountId as string }
              : l,
          ),
        );
      }
    }
  }

  const createBill = useMutation({
    mutationFn: () => {
      const payload: {
        vendorId: string;
        billDate: string;
        termsDays?: number;
        vendorReference?: string;
        memo?: string;
        lines: { accountId: string; description?: string; amount: string }[];
      } = {
        vendorId,
        billDate,
        termsDays: Number(termsDays.trim()),
        lines: lines.map((l) => ({
          accountId: l.accountId,
          description: l.description.trim() !== '' ? l.description.trim() : undefined,
          amount: centsToDecimalString(toCents(l.amount)),
        })),
      };
      if (vendorReference.trim() !== '') payload.vendorReference = vendorReference.trim();
      if (memo.trim() !== '') payload.memo = memo.trim();
      return api.post<{ id: string; number: string; approvalRequired: boolean }>(
        '/api/v1/bills',
        payload,
      );
    },
    onSuccess: (data) => {
      toast(
        'success',
        data.approvalRequired
          ? `Bill ${data.number} created — approval is required before it can be posted`
          : `Bill ${data.number} created`,
      );
      void qc.invalidateQueries({ queryKey: ['bills'] });
      setFormOpen(false);
      resetForm();
      navigate(`/expenses/bills/${data.id}`);
    },
  });

  const billItems = bills.items;
  const filtered = useMemo(
    () => billItems.filter((b) => matchesTab(b, statusTab)),
    [billItems, statusTab],
  );

  const filteredTotalCents = filtered.reduce((sum, b) => sum + toCents(b.total), 0n);
  const filteredOpenCents = filtered.reduce((sum, b) => sum + toCents(b.openBalance), 0n);

  if (bills.isLoading) return <Spinner label="Loading bills" />;
  if (bills.error) return <ErrorNote error={bills.error} />;

  return (
    <div>
      <PageHeader
        title="Bills"
        description="Vendor bills to pay later. Posting a bill records payables in the ledger; drafts stay off the books."
        actions={
          canCreate ? (
            <Button
              onClick={() => {
                createBill.reset();
                resetForm();
                setFormOpen(true);
              }}
            >
              New bill
            </Button>
          ) : undefined
        }
      />

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
          title={statusTab === 'all' ? 'No bills yet' : 'No bills match this filter'}
          description={
            statusTab === 'all'
              ? 'Enter a vendor bill to track what you owe.'
              : 'Try another status filter.'
          }
          action={
            canCreate && statusTab === 'all' ? (
              <Button
                onClick={() => {
                  createBill.reset();
                  resetForm();
                  setFormOpen(true);
                }}
              >
                New bill
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
              <TH>Bill date</TH>
              <TH>Due date</TH>
              <TH>Vendor ref</TH>
              <TH>Status</TH>
              <TH className="text-right">Total</TH>
              <TH className="text-right">Open balance</TH>
            </TR>
          </THead>
          <TBody>
            {filtered.map((bill) => {
              const badge = statusBadge(bill);
              const approval = approvalBadge(bill.approvalStatus);
              return (
                <TR
                  key={bill.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/expenses/bills/${bill.id}`)}
                >
                  <TD>
                    <button
                      type="button"
                      className="text-left font-mono text-[13px] font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        navigate(`/expenses/bills/${bill.id}`);
                      }}
                    >
                      {bill.number}
                    </button>
                  </TD>
                  <TD>{bill.vendorName}</TD>
                  <TD className="text-muted-foreground">{formatDate(bill.billDate)}</TD>
                  <TD className="text-muted-foreground">{formatDate(bill.dueDate)}</TD>
                  <TD className="text-muted-foreground">{bill.vendorReference ?? '—'}</TD>
                  <TD>
                    <span className="flex flex-wrap gap-1">
                      {approval ? <Badge tone={approval.tone}>{approval.label}</Badge> : null}
                      <Badge tone={badge.tone}>{badge.label}</Badge>
                      {isOverdue(bill, today) ? <Badge tone="danger">Overdue</Badge> : null}
                    </span>
                  </TD>
                  <TDMoney>{formatMoney(bill.total, currency)}</TDMoney>
                  <TDMoney>{formatMoney(bill.openBalance, currency)}</TDMoney>
                </TR>
              );
            })}
          </TBody>
          <TFoot>
            <TR>
              <TD
                colSpan={6}
                className="text-right text-xs uppercase tracking-wide text-muted-foreground"
              >
                Totals ({filtered.length} {filtered.length === 1 ? 'bill' : 'bills'})
              </TD>
              <TDMoney>{formatMoney(centsToDecimalString(filteredTotalCents), currency)}</TDMoney>
              <TDMoney>{formatMoney(centsToDecimalString(filteredOpenCents), currency)}</TDMoney>
            </TR>
          </TFoot>
        </Table>
      )}
      <LoadMoreButton
        hasMore={bills.hasMore}
        loading={bills.isLoadingMore}
        onClick={bills.loadMore}
      />

      {/* ----- new bill dialog ----- */}
      <Dialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) resetForm();
        }}
        title="New bill"
        description="Saved as a draft; nothing posts to the ledger until the bill is posted."
        wide
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            createBill.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="bill-vendor">Vendor</Label>
              <Select
                id="bill-vendor"
                required
                value={vendorId}
                onChange={(e) => selectVendor(e.target.value)}
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
              <Label htmlFor="bill-date">Bill date</Label>
              <Input
                id="bill-date"
                type="date"
                required
                value={billDate}
                onChange={(e) => setBillDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bill-terms">Terms (days)</Label>
              <Input
                id="bill-terms"
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

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="bill-vendor-ref">Vendor reference (optional)</Label>
              <Input
                id="bill-vendor-ref"
                value={vendorReference}
                onChange={(e) => setVendorReference(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                The vendor&apos;s own invoice or bill number.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bill-memo">Memo (optional)</Label>
              <Textarea
                id="bill-memo"
                className="min-h-[36px]"
                rows={1}
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
              />
            </div>
          </div>

          <Table>
            <THead>
              <TR>
                <TH className="w-64">Account</TH>
                <TH>Description</TH>
                <TH className="w-32 text-right">Amount</TH>
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
                      aria-label={`Account for line ${idx + 1}`}
                      required
                      value={l.accountId}
                      onChange={(e) => updateLine(l.key, { accountId: e.target.value })}
                    >
                      <option value="" disabled>
                        Select an account…
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
                      aria-label={`Amount for line ${idx + 1}`}
                      placeholder="0.00"
                      value={l.amount}
                      onChange={(e) => {
                        if (PRICE_PATTERN.test(e.target.value)) {
                          updateLine(l.key, { amount: e.target.value });
                        }
                      }}
                    />
                  </TD>
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
                  colSpan={2}
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

          {createBill.error ? <ErrorNote error={createBill.error} /> : null}

          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {!canSave
                ? 'A vendor, a bill date, terms, and at least one line with an account and a positive amount are required.'
                : 'Ready to save.'}
            </p>
            <Button type="submit" disabled={!canSave} loading={createBill.isPending}>
              Create bill
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
