import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
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
  EmptyState,
  ErrorNote,
  Label,
  PageHeader,
  Select,
  Spinner,
} from '@/components/ui/primitives';
import { Table, TBody, TD, TDMoney, TFoot, TH, THead, TR } from '@/components/ui/table';

type PostingStatus = 'draft' | 'posted' | 'voided' | 'reversed';

interface VendorCreditListItem {
  id: string;
  number: string;
  vendorId: string;
  vendorName: string;
  postingStatus: PostingStatus;
  creditDate: string;
  total: string;
  unapplied: string;
}

interface Vendor {
  id: string;
  displayName: string;
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

interface BillListItem {
  id: string;
  number: string;
  vendorId: string;
  vendorName: string;
  postingStatus: PostingStatus;
  approvalStatus: 'not_required' | 'pending' | 'approved' | 'rejected';
  billDate: string;
  dueDate: string | null;
  vendorReference: string | null;
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

/** Categories allowed on vendor-credit lines (mirrors expense split lines). */
const LINE_CATEGORIES = new Set(['expense', 'cogs', 'other_expense', 'asset']);

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
  accountId: string;
  description: string;
  amount: string;
}

function emptyLine(): FormLine {
  return { key: crypto.randomUUID(), accountId: '', description: '', amount: '' };
}

function lineIsComplete(l: FormLine): boolean {
  return l.accountId !== '' && PRICE_PATTERN.test(l.amount.trim()) && toCents(l.amount) > 0n;
}

interface ApplyRow {
  checked: boolean;
  amount: string;
}

export function VendorCreditsPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const currency = me.company?.homeCurrency ?? 'USD';
  const canCreate = can(me, 'vendor_credits.create');
  const canPost = can(me, 'vendor_credits.post');
  const canApply = can(me, 'vendor_credits.edit');

  // ----- new credit dialog state -----
  const [formOpen, setFormOpen] = useState(false);
  const [vendorId, setVendorId] = useState('');
  const [creditDate, setCreditDate] = useState(todayISO());
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<FormLine[]>([emptyLine()]);

  // ----- apply dialog state -----
  const [applyTarget, setApplyTarget] = useState<VendorCreditListItem | null>(null);
  const [effectiveDate, setEffectiveDate] = useState(todayISO());
  const [applyRows, setApplyRows] = useState<Record<string, ApplyRow>>({});

  const credits = useQuery({
    queryKey: ['vendor-credits'],
    queryFn: () => api.get<{ items: VendorCreditListItem[] }>('/api/v1/vendor-credits'),
  });
  const vendorsQuery = useQuery({
    queryKey: ['vendors'],
    queryFn: () => api.get<{ items: Vendor[] }>('/api/v1/vendors'),
    enabled: canCreate,
  });
  const accounts = useQuery({
    queryKey: ['accounts', 'for-vendor-credits'],
    queryFn: () => api.get<{ items: Account[] }>('/api/v1/accounts'),
    enabled: canCreate,
  });
  const bills = useQuery({
    queryKey: ['bills'],
    queryFn: () => api.get<{ items: BillListItem[] }>('/api/v1/bills'),
    enabled: canApply && applyTarget !== null,
  });

  const vendorOptions = (vendorsQuery.data?.items ?? []).filter((v) => v.active);
  const lineAccountOptions = (accounts.data?.items ?? []).filter(
    (a) => a.active && LINE_CATEGORIES.has(a.category),
  );

  // ----- new credit totals (exact decimal string math) -----
  const totalCents = lines.reduce(
    (sum, l) => sum + (lineIsComplete(l) ? toCents(l.amount) : 0n),
    0n,
  );
  const allLinesComplete = lines.every(lineIsComplete);
  const canSave = vendorId !== '' && creditDate !== '' && lines.length >= 1 && allLinesComplete;

  function resetForm() {
    setVendorId('');
    setCreditDate(todayISO());
    setMemo('');
    setLines([emptyLine()]);
  }

  function updateLine(key: string, patch: Partial<FormLine>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function selectVendor(nextId: string) {
    setVendorId(nextId);
    const v = vendorOptions.find((x) => x.id === nextId);
    if (!v?.defaultExpenseAccountId) return;
    const defaultId = v.defaultExpenseAccountId;
    // Prefill the vendor's default expense account on lines without one yet.
    setLines((prev) => prev.map((l) => (l.accountId === '' ? { ...l, accountId: defaultId } : l)));
  }

  const createCredit = useMutation({
    mutationFn: () => {
      const payload: {
        vendorId: string;
        creditDate: string;
        memo?: string;
        lines: { accountId: string; description?: string; amount: string }[];
      } = {
        vendorId,
        creditDate,
        lines: lines.map((l) => ({
          accountId: l.accountId,
          description: l.description.trim() !== '' ? l.description.trim() : undefined,
          amount: centsToDecimalString(toCents(l.amount)),
        })),
      };
      if (memo.trim() !== '') payload.memo = memo.trim();
      return api.post<{ id: string; number: string }>('/api/v1/vendor-credits', payload);
    },
    onSuccess: (data) => {
      toast('success', `Vendor credit ${data.number} created as a draft`);
      void qc.invalidateQueries({ queryKey: ['vendor-credits'] });
      setFormOpen(false);
      resetForm();
    },
  });

  const postCredit = useMutation({
    mutationFn: (id: string) =>
      api.post<{ journalEntryId: string }>(`/api/v1/vendor-credits/${id}/post`, {
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: () => {
      toast('success', 'Vendor credit posted');
      void qc.invalidateQueries({ queryKey: ['vendor-credits'] });
      void qc.invalidateQueries({ queryKey: ['ap-aging'] });
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

  // ----- apply math (exact decimal string math) -----
  const openBills = applyTarget
    ? (bills.data?.items ?? []).filter(
        (b) =>
          b.vendorId === applyTarget.vendorId &&
          b.postingStatus === 'posted' &&
          toCents(b.openBalance) > 0n,
      )
    : [];
  const checkedApplyRows = openBills
    .map((bill) => ({ bill, row: applyRows[bill.id] }))
    .filter((r): r is { bill: BillListItem; row: ApplyRow } => r.row?.checked === true);
  const appliedCents = checkedApplyRows.reduce((sum, r) => sum + toCents(r.row.amount), 0n);
  const unappliedCents = applyTarget ? toCents(applyTarget.unapplied) : 0n;
  const remainingCents = unappliedCents - appliedCents;
  const applyRowsValid = checkedApplyRows.every((r) => {
    const c = toCents(r.row.amount);
    return c > 0n && c <= toCents(r.bill.openBalance);
  });
  const canSubmitApply =
    applyTarget !== null &&
    effectiveDate !== '' &&
    checkedApplyRows.length > 0 &&
    applyRowsValid &&
    remainingCents >= 0n;

  function toggleApplyRow(bill: BillListItem, checked: boolean) {
    setApplyRows((prev) => {
      if (!checked) {
        return { ...prev, [bill.id]: { checked: false, amount: prev[bill.id]?.amount ?? '' } };
      }
      // Default to min(bill open balance, credit remaining to apply).
      const appliedExcluding = openBills.reduce((sum, other) => {
        if (other.id === bill.id) return sum;
        const row = prev[other.id];
        return row?.checked ? sum + toCents(row.amount) : sum;
      }, 0n);
      const remaining = unappliedCents - appliedExcluding;
      const open = toCents(bill.openBalance);
      const def = remaining <= 0n ? 0n : remaining < open ? remaining : open;
      return { ...prev, [bill.id]: { checked: true, amount: centsToDecimalString(def) } };
    });
  }

  function setApplyAmount(billId: string, raw: string) {
    if (!PRICE_PATTERN.test(raw)) return;
    setApplyRows((prev) => ({
      ...prev,
      [billId]: { checked: prev[billId]?.checked ?? true, amount: raw },
    }));
  }

  const applyCredit = useMutation({
    mutationFn: (input: { id: string }) =>
      api.post<{ ok: boolean }>(`/api/v1/vendor-credits/${input.id}/apply`, {
        allocations: checkedApplyRows.map((r) => ({
          billId: r.bill.id,
          amount: centsToDecimalString(toCents(r.row.amount)),
        })),
        effectiveDate,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: () => {
      toast('success', 'Credit applied to bills');
      void qc.invalidateQueries({ queryKey: ['vendor-credits'] });
      void qc.invalidateQueries({ queryKey: ['bills'] });
      void qc.invalidateQueries({ queryKey: ['bill'] });
      void qc.invalidateQueries({ queryKey: ['ap-aging'] });
      setApplyTarget(null);
      setApplyRows({});
    },
  });

  if (credits.isLoading) return <Spinner label="Loading vendor credits" />;
  if (credits.error) return <ErrorNote error={credits.error} />;

  const items = credits.data?.items ?? [];

  return (
    <div>
      <PageHeader
        title="Vendor credits"
        description="Credits owed to you by vendors. Post a credit to reduce Accounts Payable, then apply it against open bills."
        actions={
          canCreate ? (
            <Button
              onClick={() => {
                createCredit.reset();
                resetForm();
                setFormOpen(true);
              }}
            >
              New vendor credit
            </Button>
          ) : undefined
        }
      />

      {items.length === 0 ? (
        <EmptyState
          title="No vendor credits yet"
          description="Record a vendor credit when a vendor owes you money back."
          action={
            canCreate ? (
              <Button
                onClick={() => {
                  createCredit.reset();
                  resetForm();
                  setFormOpen(true);
                }}
              >
                New vendor credit
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
              <TH className="text-right">Total</TH>
              <TH className="text-right">Unapplied</TH>
              <TH>Status</TH>
              <TH className="w-40">Actions</TH>
            </TR>
          </THead>
          <TBody>
            {items.map((c) => {
              const cUnapplied = toCents(c.unapplied);
              return (
                <TR key={c.id}>
                  <TD className="font-mono text-[13px] font-medium">{c.number}</TD>
                  <TD>{c.vendorName}</TD>
                  <TD className="text-muted-foreground">{formatDate(c.creditDate)}</TD>
                  <TDMoney>{formatMoney(c.total, currency)}</TDMoney>
                  <TDMoney>
                    {cUnapplied > 0n ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Badge tone="warning">Unapplied</Badge>
                        {formatMoney(c.unapplied, currency)}
                      </span>
                    ) : (
                      formatMoney(c.unapplied, currency)
                    )}
                  </TDMoney>
                  <TD>
                    <Badge tone={STATUS_TONES[c.postingStatus]}>{c.postingStatus}</Badge>
                  </TD>
                  <TD>
                    {canPost && c.postingStatus === 'draft' ? (
                      <Button
                        variant="outline"
                        size="sm"
                        loading={postCredit.isPending && postCredit.variables === c.id}
                        onClick={() => postCredit.mutate(c.id)}
                      >
                        Post
                      </Button>
                    ) : canApply && c.postingStatus === 'posted' && cUnapplied > 0n ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          applyCredit.reset();
                          setApplyTarget(c);
                          setEffectiveDate(todayISO());
                          setApplyRows({});
                        }}
                      >
                        Apply to bills
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}

      {/* ----- new vendor credit dialog ----- */}
      <Dialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) resetForm();
        }}
        title="New vendor credit"
        description="Saved as a draft; nothing posts to the ledger until the credit is posted."
        wide
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            createCredit.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="vc-vendor">Vendor</Label>
              <Select
                id="vc-vendor"
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
              <Label htmlFor="vc-date">Credit date</Label>
              <Input
                id="vc-date"
                type="date"
                required
                value={creditDate}
                onChange={(e) => setCreditDate(e.target.value)}
              />
            </div>
          </div>

          <Table>
            <THead>
              <TR>
                <TH className="w-56">Account</TH>
                <TH>Description</TH>
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

          <div className="flex items-center justify-between gap-3">
            <Button variant="outline" onClick={() => setLines((prev) => [...prev, emptyLine()])}>
              Add line
            </Button>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="vc-memo">Memo (optional)</Label>
            <Textarea id="vc-memo" value={memo} onChange={(e) => setMemo(e.target.value)} />
          </div>

          {createCredit.error ? <ApiErrorNote error={createCredit.error} /> : null}

          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {!canSave
                ? 'A vendor, a date, and at least one line with an account and a positive amount are required.'
                : 'Ready to save.'}
            </p>
            <Button type="submit" disabled={!canSave} loading={createCredit.isPending}>
              Create credit
            </Button>
          </div>
        </form>
      </Dialog>

      {/* ----- apply to bills dialog ----- */}
      <Dialog
        open={applyTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setApplyTarget(null);
            setApplyRows({});
          }
        }}
        title="Apply credit to bills"
        description={
          applyTarget
            ? `Applies credit ${applyTarget.number} (${formatMoney(applyTarget.unapplied, currency)} unapplied) against ${applyTarget.vendorName}'s open bills.`
            : undefined
        }
        wide
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!applyTarget) return;
            applyCredit.mutate({ id: applyTarget.id });
          }}
        >
          <div className="max-w-xs space-y-1.5">
            <Label htmlFor="vc-apply-date">Effective date</Label>
            <Input
              id="vc-apply-date"
              type="date"
              required
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
            />
          </div>

          {bills.isLoading ? (
            <Spinner label="Loading open bills" />
          ) : bills.error ? (
            <ErrorNote error={bills.error} />
          ) : openBills.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This vendor has no posted open bills to apply the credit against.
            </p>
          ) : (
            <>
              <Table>
                <THead>
                  <TR>
                    <TH className="w-12">Apply</TH>
                    <TH>Bill</TH>
                    <TH>Due date</TH>
                    <TH className="text-right">Open balance</TH>
                    <TH className="w-32 text-right">Credit</TH>
                  </TR>
                </THead>
                <TBody>
                  {openBills.map((bill) => {
                    const row = applyRows[bill.id];
                    const checked = row?.checked === true;
                    const rowCents = row ? toCents(row.amount) : 0n;
                    const overOpen = checked && rowCents > toCents(bill.openBalance);
                    return (
                      <TR key={bill.id}>
                        <TD className="text-center">
                          <input
                            type="checkbox"
                            aria-label={`Apply credit to bill ${bill.number}`}
                            className="h-4 w-4 rounded border-input"
                            checked={checked}
                            onChange={(e) => toggleApplyRow(bill, e.target.checked)}
                          />
                        </TD>
                        <TD className="font-mono text-[13px]">{bill.number}</TD>
                        <TD className="text-muted-foreground">{formatDate(bill.dueDate)}</TD>
                        <TDMoney>{formatMoney(bill.openBalance, currency)}</TDMoney>
                        <TD>
                          <MoneyInput
                            aria-label={`Credit amount to apply to bill ${bill.number}`}
                            placeholder="0.00"
                            disabled={!checked}
                            value={checked ? (row?.amount ?? '') : ''}
                            onChange={(e) => setApplyAmount(bill.id, e.target.value)}
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
                  className={remainingCents < 0n ? 'text-destructive' : 'text-muted-foreground'}
                >
                  Credit remaining:{' '}
                  <span data-money className="font-mono tabular-nums">
                    {formatMoney(centsToDecimalString(remainingCents), currency)}
                  </span>
                </span>
              </div>
            </>
          )}

          {applyCredit.error ? <ApiErrorNote error={applyCredit.error} /> : null}

          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {!canSubmitApply
                ? remainingCents < 0n
                  ? 'Applied amounts exceed the unapplied credit.'
                  : !applyRowsValid
                    ? 'Each applied amount must be greater than zero and no more than the bill open balance.'
                    : 'Select at least one bill and enter an effective date.'
                : 'Ready to apply.'}
            </p>
            <Button type="submit" disabled={!canSubmitApply} loading={applyCredit.isPending}>
              Apply credit
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
