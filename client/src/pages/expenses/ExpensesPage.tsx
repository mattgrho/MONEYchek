import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
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
type ExpenseMethod = 'check' | 'card' | 'cash' | 'ach' | 'other';

interface ExpenseListItem {
  id: string;
  number: string;
  vendorId: string | null;
  vendorName: string | null;
  payeeName: string | null;
  postingStatus: PostingStatus;
  expenseDate: string;
  method: ExpenseMethod;
  reference: string | null;
  total: string;
  paymentAccountId: string;
}

interface ExpenseLine {
  id: string;
  lineNumber: number;
  accountId: string;
  description: string | null;
  amount: string;
}

interface ExpenseDetail extends ExpenseListItem {
  memo: string | null;
  lines: ExpenseLine[];
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

const STATUS_TONES: Record<PostingStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  draft: 'neutral',
  posted: 'success',
  voided: 'danger',
  reversed: 'warning',
};

const METHOD_OPTIONS: { value: ExpenseMethod; label: string }[] = [
  { value: 'check', label: 'Check' },
  { value: 'card', label: 'Card' },
  { value: 'cash', label: 'Cash' },
  { value: 'ach', label: 'ACH' },
  { value: 'other', label: 'Other' },
];

const METHOD_LABELS: Record<ExpenseMethod, string> = {
  check: 'Check',
  card: 'Card',
  cash: 'Cash',
  ach: 'ACH',
  other: 'Other',
};

/** Categories allowed on expense split lines. */
const SPLIT_CATEGORIES = new Set(['expense', 'cogs', 'other_expense', 'asset']);

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
  const hint =
    error instanceof ApiError && error.code === 'LINE_RECONCILED'
      ? 'One of this expense’s ledger lines has been reconciled against a bank statement. Undo the reconciliation for that period before voiding.'
      : null;
  return (
    <div
      role="alert"
      className="space-y-1 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      <p>{message}</p>
      {hint ? <p className="text-xs">{hint}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Split-line editor state
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

export function ExpensesPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const currency = me.company?.homeCurrency ?? 'USD';
  const canCreate = can(me, 'expenses.create');
  const canVoid = can(me, 'expenses.void');

  const [expandedId, setExpandedId] = useState<string | null>(null);

  // ----- new expense dialog state -----
  const [formOpen, setFormOpen] = useState(false);
  const [vendorId, setVendorId] = useState('');
  const [payeeName, setPayeeName] = useState('');
  const [expenseDate, setExpenseDate] = useState(todayISO());
  const [paymentAccountId, setPaymentAccountId] = useState('');
  const [method, setMethod] = useState<ExpenseMethod>('check');
  const [reference, setReference] = useState('');
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<FormLine[]>([emptyLine()]);

  // ----- void dialog state -----
  const [voidTarget, setVoidTarget] = useState<ExpenseListItem | null>(null);
  const [voidReason, setVoidReason] = useState('');

  const expensesQuery = usePagedList<ExpenseListItem>(['expenses'], '/api/v1/expenses');
  const accounts = useQuery({
    queryKey: ['accounts', 'for-expenses'],
    queryFn: () => api.get<{ items: Account[] }>('/api/v1/accounts'),
  });
  const vendorsQuery = useQuery({
    queryKey: ['vendors'],
    queryFn: () => api.get<{ items: Vendor[] }>('/api/v1/vendors'),
    enabled: canCreate,
  });
  const expandedExpense = useQuery({
    queryKey: ['expense', expandedId],
    queryFn: () => api.get<ExpenseDetail>(`/api/v1/expenses/${expandedId}`),
    enabled: expandedId !== null,
  });

  const accountItems = useMemo(() => accounts.data?.items ?? [], [accounts.data]);
  const accountNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of accountItems) map.set(a.id, a.name);
    return map;
  }, [accountItems]);

  const paymentAccountOptions = accountItems.filter(
    (a) => a.active && (a.bankKind === 'bank' || a.bankKind === 'credit_card'),
  );
  const splitAccountOptions = accountItems.filter(
    (a) => a.active && SPLIT_CATEGORIES.has(a.category),
  );
  const vendorOptions = (vendorsQuery.data?.items ?? []).filter((v) => v.active);

  // ----- totals (exact decimal string math) -----
  const totalCents = lines.reduce(
    (sum, l) => sum + (lineIsComplete(l) ? toCents(l.amount) : 0n),
    0n,
  );

  const payeeChosen = vendorId !== '' || payeeName.trim() !== '';
  const allLinesComplete = lines.every(lineIsComplete);
  const canSave =
    payeeChosen &&
    expenseDate !== '' &&
    paymentAccountId !== '' &&
    lines.length >= 1 &&
    allLinesComplete;

  function resetForm() {
    setVendorId('');
    setPayeeName('');
    setExpenseDate(todayISO());
    setPaymentAccountId('');
    setMethod('check');
    setReference('');
    setMemo('');
    setLines([emptyLine()]);
  }

  function updateLine(key: string, patch: Partial<FormLine>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function selectVendor(nextId: string) {
    setVendorId(nextId);
    if (nextId === '') return;
    setPayeeName('');
    const v = vendorOptions.find((x) => x.id === nextId);
    if (!v?.defaultExpenseAccountId) return;
    const defaultId = v.defaultExpenseAccountId;
    if (!splitAccountOptions.some((a) => a.id === defaultId)) return;
    // Prefill the vendor's default expense account on lines without one yet.
    setLines((prev) => prev.map((l) => (l.accountId === '' ? { ...l, accountId: defaultId } : l)));
  }

  const createExpense = useMutation({
    mutationFn: () => {
      const payload: {
        vendorId?: string;
        payeeName?: string;
        expenseDate: string;
        paymentAccountId: string;
        method: ExpenseMethod;
        reference?: string;
        memo?: string;
        lines: { accountId: string; description?: string; amount: string }[];
        idempotencyKey: string;
      } = {
        expenseDate,
        paymentAccountId,
        method,
        lines: lines.map((l) => ({
          accountId: l.accountId,
          description: l.description.trim() !== '' ? l.description.trim() : undefined,
          amount: centsToDecimalString(toCents(l.amount)),
        })),
        idempotencyKey: crypto.randomUUID(),
      };
      if (vendorId !== '') payload.vendorId = vendorId;
      else payload.payeeName = payeeName.trim();
      if (reference.trim() !== '') payload.reference = reference.trim();
      if (memo.trim() !== '') payload.memo = memo.trim();
      return api.post<{ id: string; number: string }>('/api/v1/expenses', payload);
    },
    onSuccess: (data) => {
      toast('success', `Expense ${data.number} posted`);
      void qc.invalidateQueries({ queryKey: ['expenses'] });
      void qc.invalidateQueries({ queryKey: ['expense'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      setFormOpen(false);
      resetForm();
    },
  });

  const voidExpense = useMutation({
    mutationFn: (input: { id: string; reason: string }) =>
      api.post<{ reversalEntryId: string }>(`/api/v1/expenses/${input.id}/void`, {
        idempotencyKey: crypto.randomUUID(),
        reason: input.reason,
      }),
    onSuccess: () => {
      toast('success', 'Expense voided');
      void qc.invalidateQueries({ queryKey: ['expenses'] });
      void qc.invalidateQueries({ queryKey: ['expense'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      setVoidTarget(null);
    },
  });

  if (expensesQuery.isLoading) return <Spinner label="Loading expenses" />;
  if (expensesQuery.error) return <ErrorNote error={expensesQuery.error} />;

  const items = expensesQuery.items;
  const detail = expandedExpense.data;

  return (
    <div>
      <PageHeader
        title="Expenses"
        description="Money already spent from a bank or credit card account. Expenses post to the ledger immediately when saved."
        actions={
          canCreate ? (
            <Button
              onClick={() => {
                createExpense.reset();
                resetForm();
                setFormOpen(true);
              }}
            >
              New expense
            </Button>
          ) : undefined
        }
      />

      {items.length === 0 ? (
        <EmptyState
          title="No expenses yet"
          description="Record an expense to capture money spent outside of the bills workflow."
          action={
            canCreate ? (
              <Button
                onClick={() => {
                  createExpense.reset();
                  resetForm();
                  setFormOpen(true);
                }}
              >
                New expense
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH className="w-8">
                <span className="sr-only">Expand</span>
              </TH>
              <TH>Number</TH>
              <TH>Date</TH>
              <TH>Payee</TH>
              <TH>Method</TH>
              <TH>Reference</TH>
              <TH>Paid from</TH>
              <TH className="text-right">Total</TH>
              <TH>Status</TH>
              <TH className="w-24">Actions</TH>
            </TR>
          </THead>
          <TBody>
            {items.map((exp) => {
              const isExpanded = expandedId === exp.id;
              return (
                <ExpenseRowGroup key={exp.id}>
                  <TR>
                    <TD>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        aria-expanded={isExpanded}
                        aria-label={
                          isExpanded
                            ? `Collapse expense ${exp.number}`
                            : `Expand expense ${exp.number} to see category lines`
                        }
                        onClick={() => setExpandedId(isExpanded ? null : exp.id)}
                      >
                        {isExpanded ? (
                          <ChevronDown className="h-4 w-4" aria-hidden />
                        ) : (
                          <ChevronRight className="h-4 w-4" aria-hidden />
                        )}
                      </Button>
                    </TD>
                    <TD className="font-mono text-[13px] font-medium">{exp.number}</TD>
                    <TD className="text-muted-foreground">{formatDate(exp.expenseDate)}</TD>
                    <TD>{exp.vendorName ?? exp.payeeName ?? '—'}</TD>
                    <TD className="text-muted-foreground">{METHOD_LABELS[exp.method]}</TD>
                    <TD className="text-muted-foreground">{exp.reference ?? '—'}</TD>
                    <TD className="text-muted-foreground">
                      {accountNameById.get(exp.paymentAccountId) ?? '—'}
                    </TD>
                    <TDMoney>{formatMoney(exp.total, currency)}</TDMoney>
                    <TD>
                      <Badge tone={STATUS_TONES[exp.postingStatus]}>{exp.postingStatus}</Badge>
                    </TD>
                    <TD>
                      {canVoid && exp.postingStatus === 'posted' ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive"
                          onClick={() => {
                            voidExpense.reset();
                            setVoidTarget(exp);
                            setVoidReason('');
                          }}
                        >
                          Void
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TD>
                  </TR>
                  {isExpanded ? (
                    <TR className="bg-muted/30 hover:bg-muted/30">
                      <TD colSpan={10} className="p-4">
                        {expandedExpense.isLoading ? (
                          <Spinner label="Loading expense lines" />
                        ) : expandedExpense.error ? (
                          <ErrorNote error={expandedExpense.error} />
                        ) : detail ? (
                          <div className="space-y-3">
                            <h4 className="text-sm font-semibold">Category lines</h4>
                            <Table>
                              <THead>
                                <TR>
                                  <TH className="w-12">#</TH>
                                  <TH>Category</TH>
                                  <TH>Description</TH>
                                  <TH className="text-right">Amount</TH>
                                </TR>
                              </THead>
                              <TBody>
                                {detail.lines.map((l) => (
                                  <TR key={l.id}>
                                    <TD className="text-muted-foreground">{l.lineNumber}</TD>
                                    <TD>{accountNameById.get(l.accountId) ?? l.accountId}</TD>
                                    <TD className="text-muted-foreground">
                                      {l.description ?? '—'}
                                    </TD>
                                    <TDMoney>{formatMoney(l.amount, currency)}</TDMoney>
                                  </TR>
                                ))}
                              </TBody>
                              <TFoot>
                                <TR>
                                  <TD
                                    colSpan={3}
                                    className="text-right text-xs uppercase tracking-wide text-muted-foreground"
                                  >
                                    Total
                                  </TD>
                                  <TDMoney>{formatMoney(detail.total, currency)}</TDMoney>
                                </TR>
                              </TFoot>
                            </Table>
                            {detail.memo ? (
                              <p className="text-sm text-muted-foreground">Memo: {detail.memo}</p>
                            ) : null}
                          </div>
                        ) : null}
                      </TD>
                    </TR>
                  ) : null}
                </ExpenseRowGroup>
              );
            })}
          </TBody>
        </Table>
      )}
      <LoadMoreButton
        hasMore={expensesQuery.hasMore}
        loading={expensesQuery.isLoadingMore}
        onClick={expensesQuery.loadMore}
      />

      {/* ----- new expense dialog ----- */}
      <Dialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) resetForm();
        }}
        title="New expense"
        description="Records money already spent. Saving posts the expense to the ledger immediately."
        wide
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            createExpense.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="exp-vendor">Vendor</Label>
              <Select
                id="exp-vendor"
                value={vendorId}
                onChange={(e) => selectVendor(e.target.value)}
              >
                <option value="">No vendor (enter payee below)</option>
                {vendorOptions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.displayName}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="exp-payee">Payee name</Label>
              <Input
                id="exp-payee"
                value={vendorId !== '' ? '' : payeeName}
                disabled={vendorId !== ''}
                placeholder={vendorId !== '' ? 'Using the selected vendor' : 'e.g. Corner Coffee'}
                onChange={(e) => setPayeeName(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Pick a vendor or type a one-off payee name.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="exp-date">Expense date</Label>
              <Input
                id="exp-date"
                type="date"
                required
                value={expenseDate}
                onChange={(e) => setExpenseDate(e.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="exp-payment-account">Payment account</Label>
              <Select
                id="exp-payment-account"
                required
                value={paymentAccountId}
                onChange={(e) => setPaymentAccountId(e.target.value)}
              >
                <option value="" disabled>
                  Select a bank or card account…
                </option>
                {paymentAccountOptions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.number ? `${a.number} · ${a.name}` : a.name}
                    {a.bankKind === 'credit_card' ? ' (credit card)' : ''}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="exp-method">Method</Label>
              <Select
                id="exp-method"
                required
                value={method}
                onChange={(e) => setMethod(e.target.value as ExpenseMethod)}
              >
                {METHOD_OPTIONS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="exp-reference">Reference (optional)</Label>
              <Input
                id="exp-reference"
                placeholder="Check no., last 4…"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </div>
          </div>

          <Table>
            <THead>
              <TR>
                <TH className="w-56">Category</TH>
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
                      aria-label={`Category account for line ${idx + 1}`}
                      required
                      value={l.accountId}
                      onChange={(e) => updateLine(l.key, { accountId: e.target.value })}
                    >
                      <option value="" disabled>
                        Select an account…
                      </option>
                      {splitAccountOptions.map((a) => (
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
            <div className="w-72 space-y-1.5">
              <Label htmlFor="exp-memo">Memo (optional)</Label>
              <Textarea
                id="exp-memo"
                className="min-h-[36px]"
                rows={1}
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
              />
            </div>
          </div>

          {createExpense.error ? <ApiErrorNote error={createExpense.error} /> : null}

          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {!canSave
                ? 'A payee (vendor or name), date, payment account, and at least one line with a category and a positive amount are required.'
                : 'Saving posts this expense to the ledger immediately.'}
            </p>
            <Button type="submit" disabled={!canSave} loading={createExpense.isPending}>
              Save &amp; post
            </Button>
          </div>
        </form>
      </Dialog>

      {/* ----- void dialog ----- */}
      <Dialog
        open={voidTarget !== null}
        onOpenChange={(open) => {
          if (!open) setVoidTarget(null);
        }}
        title="Void expense"
        description={
          voidTarget
            ? `Posts a reversal that cancels expense ${voidTarget.number} of ${formatMoney(voidTarget.total, currency)}. The original entry is never altered.`
            : undefined
        }
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!voidTarget) return;
            voidExpense.mutate({ id: voidTarget.id, reason: voidReason.trim() });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="exp-void-reason">Reason</Label>
            <Textarea
              id="exp-void-reason"
              required
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
            />
          </div>
          {voidExpense.error ? <ApiErrorNote error={voidExpense.error} /> : null}
          <Button
            type="submit"
            variant="destructive"
            className="w-full"
            disabled={voidReason.trim().length < 3}
            loading={voidExpense.isPending}
          >
            Void expense
          </Button>
        </form>
      </Dialog>
    </div>
  );
}

/** Groups an expense row with its optional expanded-details row. */
function ExpenseRowGroup({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
