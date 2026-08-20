import { useMemo, useState, type ChangeEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import type { Me } from '@/lib/types';
import { can } from '@/lib/types';
import { cn, formatDate, formatMoney } from '@/lib/utils';
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
import { Table, TBody, TD, TDMoney, TH, THead, TR } from '@/components/ui/table';

type ItemState =
  'new' | 'suggested' | 'matched' | 'added' | 'excluded' | 'possible_duplicate' | 'needs_info';

interface BankingAccount {
  accountId: string;
  kind: 'bank' | 'credit_card';
  institutionName: string | null;
  accountMask: string | null;
  name: string;
  number: string | null;
  bookBalance: string;
  clearedBalance: string;
  reconciledThrough: string | null;
  lastStatementBalance: string | null;
}

interface BankItem {
  id: string;
  accountId: string;
  txnDate: string;
  description: string;
  reference: string | null;
  /** Signed; positive = money in. */
  amount: string;
  state: ItemState;
  appliedRuleId: string | null;
  matchedJournalEntryId: string | null;
}

interface Suggestion {
  journalEntryId: string;
  entryNumber: string;
  postingDate: string;
  sourceType: string;
  memo: string | null;
  amount: string;
  lineId: string;
}

interface ChartAccount {
  id: string;
  number: string | null;
  name: string;
  category: string;
  detailType: string | null;
  systemKey: string | null;
  bankKind: 'bank' | 'credit_card' | null;
  active: boolean;
}

interface DryRunResult {
  rowCount: number;
  importedCount: number;
  duplicateCount: number;
  errorCount: number;
  errors: { row: number; message: string }[];
  preview: {
    rowNumber: number;
    date: string;
    description: string;
    reference: string | null;
    amount: string;
  }[];
  batchId?: string;
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

function absCents(cents: bigint): bigint {
  return cents < 0n ? -cents : cents;
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
// State presentation
// ---------------------------------------------------------------------------

const DUPLICATE_TITLE =
  'This transaction looks like one that was already imported. A human should review it before it is added or excluded.';

function StateBadge({ state }: { state: ItemState }) {
  switch (state) {
    case 'new':
      return <Badge tone="info">New</Badge>;
    case 'suggested':
      return <Badge tone="info">Suggested</Badge>;
    case 'matched':
      return <Badge tone="success">Matched</Badge>;
    case 'added':
      return <Badge tone="success">Added</Badge>;
    case 'excluded':
      return <Badge tone="neutral">Excluded</Badge>;
    case 'needs_info':
      return <Badge tone="warning">Needs info</Badge>;
    case 'possible_duplicate':
      return (
        <Badge tone="warning" title={DUPLICATE_TITLE}>
          Possible duplicate
        </Badge>
      );
  }
}

/** Signed amount cell: money in is green, money out is plain. */
function AmountCell({ amount, currency }: { amount: string; currency: string }) {
  const moneyIn = toCents(amount) > 0n;
  return (
    <TDMoney className={moneyIn ? 'text-success' : undefined}>
      {moneyIn ? `+${formatMoney(amount, currency)}` : formatMoney(amount, currency)}
    </TDMoney>
  );
}

// ---------------------------------------------------------------------------
// Categorize dialog split rows
// ---------------------------------------------------------------------------

interface SplitRow {
  key: string;
  accountId: string;
  amount: string;
  memo: string;
}

function emptySplit(amount = ''): SplitRow {
  return { key: crypto.randomUUID(), accountId: '', amount, memo: '' };
}

type ReviewTab = 'for_review' | 'resolved' | 'excluded';

const REVIEW_TABS: { key: ReviewTab; label: string }[] = [
  { key: 'for_review', label: 'For review' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'excluded', label: 'Excluded' },
];

type DateFormat = 'MDY' | 'DMY' | 'YMD';

export function BankingReviewPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const currency = me.company?.homeCurrency ?? 'USD';
  const canImport = can(me, 'banking.create');
  const canPost = can(me, 'banking.post');

  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [tab, setTab] = useState<ReviewTab>('for_review');

  // ----- import dialog state -----
  const [importOpen, setImportOpen] = useState(false);
  const [importStep, setImportStep] = useState<1 | 2 | 3>(1);
  const [csvContent, setCsvContent] = useState('');
  const [filename, setFilename] = useState('');
  const [pasted, setPasted] = useState('');
  const [hasHeader, setHasHeader] = useState(true);
  const [dateFormat, setDateFormat] = useState<DateFormat>('MDY');
  const [dateColumn, setDateColumn] = useState('');
  const [descriptionColumn, setDescriptionColumn] = useState('');
  const [referenceColumn, setReferenceColumn] = useState('');
  const [amountMode, setAmountMode] = useState<'single' | 'split'>('single');
  const [amountColumn, setAmountColumn] = useState('');
  const [debitColumn, setDebitColumn] = useState('');
  const [creditColumn, setCreditColumn] = useState('');
  const [positiveIsMoneyIn, setPositiveIsMoneyIn] = useState(true);

  // ----- per-row action dialog state -----
  const [matchTarget, setMatchTarget] = useState<BankItem | null>(null);
  const [categorizeTarget, setCategorizeTarget] = useState<BankItem | null>(null);
  const [splits, setSplits] = useState<SplitRow[]>([emptySplit()]);
  const [payeeName, setPayeeName] = useState('');
  const [transferTarget, setTransferTarget] = useState<BankItem | null>(null);
  const [transferOtherAccountId, setTransferOtherAccountId] = useState('');

  const bankAccounts = useQuery({
    queryKey: ['banking-accounts'],
    queryFn: () => api.get<{ items: BankingAccount[] }>('/api/v1/banking/accounts'),
  });
  const chartAccounts = useQuery({
    queryKey: ['accounts', 'for-banking-review'],
    queryFn: () => api.get<{ items: ChartAccount[] }>('/api/v1/accounts'),
    enabled: canPost,
  });

  const accounts = bankAccounts.data?.items ?? [];
  const activeAccountId = selectedAccountId ?? accounts[0]?.accountId ?? null;
  const activeAccount = accounts.find((a) => a.accountId === activeAccountId) ?? null;

  const forReviewItems = useQuery({
    queryKey: ['banking-items', activeAccountId, 'for_review'],
    queryFn: () =>
      api.get<{ items: BankItem[] }>(
        `/api/v1/banking/items?accountId=${encodeURIComponent(activeAccountId ?? '')}&state=for_review`,
      ),
    enabled: activeAccountId !== null,
  });
  const matchedItems = useQuery({
    queryKey: ['banking-items', activeAccountId, 'matched'],
    queryFn: () =>
      api.get<{ items: BankItem[] }>(
        `/api/v1/banking/items?accountId=${encodeURIComponent(activeAccountId ?? '')}&state=matched`,
      ),
    enabled: activeAccountId !== null && tab === 'resolved',
  });
  const addedItems = useQuery({
    queryKey: ['banking-items', activeAccountId, 'added'],
    queryFn: () =>
      api.get<{ items: BankItem[] }>(
        `/api/v1/banking/items?accountId=${encodeURIComponent(activeAccountId ?? '')}&state=added`,
      ),
    enabled: activeAccountId !== null && tab === 'resolved',
  });
  const excludedItems = useQuery({
    queryKey: ['banking-items', activeAccountId, 'excluded'],
    queryFn: () =>
      api.get<{ items: BankItem[] }>(
        `/api/v1/banking/items?accountId=${encodeURIComponent(activeAccountId ?? '')}&state=excluded`,
      ),
    enabled: activeAccountId !== null && tab === 'excluded',
  });
  const suggestions = useQuery({
    queryKey: ['banking-suggestions', matchTarget?.id],
    queryFn: () =>
      api.get<{ items: Suggestion[] }>(`/api/v1/banking/items/${matchTarget?.id}/suggestions`),
    enabled: matchTarget !== null,
  });

  const categoryAccountOptions = (chartAccounts.data?.items ?? []).filter(
    (a) => a.active && a.bankKind === null,
  );

  function invalidateItems() {
    void qc.invalidateQueries({ queryKey: ['banking-items'] });
    void qc.invalidateQueries({ queryKey: ['banking-accounts'] });
  }

  // ----- import: CSV columns from the first row -----
  const firstLine = csvContent.split(/\r?\n/)[0] ?? '';
  const columnOptions = useMemo(() => {
    if (firstLine === '') return [];
    return firstLine.split(',').map((cell, idx) => ({
      value: String(idx),
      label: hasHeader
        ? `${idx + 1}: ${cell.trim() !== '' ? cell.trim() : '(blank header)'}`
        : `Column ${idx + 1}`,
    }));
  }, [firstLine, hasHeader]);

  const mappingComplete =
    dateColumn !== '' &&
    descriptionColumn !== '' &&
    (amountMode === 'single' ? amountColumn !== '' : debitColumn !== '' && creditColumn !== '');

  function buildMapping() {
    const mapping: {
      dateColumn: number;
      descriptionColumn: number;
      referenceColumn?: number;
      amountColumn?: number;
      debitColumn?: number;
      creditColumn?: number;
      dateFormat: DateFormat;
      hasHeader: boolean;
      positiveIsMoneyIn?: boolean;
    } = {
      dateColumn: Number(dateColumn),
      descriptionColumn: Number(descriptionColumn),
      dateFormat,
      hasHeader,
    };
    if (referenceColumn !== '') mapping.referenceColumn = Number(referenceColumn);
    if (amountMode === 'single') {
      mapping.amountColumn = Number(amountColumn);
      mapping.positiveIsMoneyIn = positiveIsMoneyIn;
    } else {
      mapping.debitColumn = Number(debitColumn);
      mapping.creditColumn = Number(creditColumn);
    }
    return mapping;
  }

  const dryRun = useMutation({
    mutationFn: () =>
      api.post<DryRunResult>('/api/v1/banking/import', {
        accountId: activeAccountId,
        filename: filename !== '' ? filename : 'pasted.csv',
        content: csvContent,
        mapping: buildMapping(),
        dryRun: true,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: () => setImportStep(3),
  });

  const executeImport = useMutation({
    mutationFn: () =>
      api.post<DryRunResult>('/api/v1/banking/import', {
        accountId: activeAccountId,
        filename: filename !== '' ? filename : 'pasted.csv',
        content: csvContent,
        mapping: buildMapping(),
        dryRun: false,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: (data) => {
      toast(
        'success',
        `Imported ${data.importedCount} ${data.importedCount === 1 ? 'transaction' : 'transactions'}${
          data.duplicateCount > 0 ? ` (${data.duplicateCount} duplicate rows skipped)` : ''
        }`,
      );
      invalidateItems();
      setImportOpen(false);
      resetImport();
    },
  });

  function resetImport() {
    setImportStep(1);
    setCsvContent('');
    setFilename('');
    setPasted('');
    setHasHeader(true);
    setDateFormat('MDY');
    setDateColumn('');
    setDescriptionColumn('');
    setReferenceColumn('');
    setAmountMode('single');
    setAmountColumn('');
    setDebitColumn('');
    setCreditColumn('');
    setPositiveIsMoneyIn(true);
    dryRun.reset();
    executeImport.reset();
  }

  function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setCsvContent(typeof reader.result === 'string' ? reader.result : '');
      setFilename(file.name);
      setPasted('');
    };
    reader.readAsText(file);
  }

  // ----- row action mutations -----
  const matchItem = useMutation({
    mutationFn: (input: { itemId: string; journalEntryId: string }) =>
      api.post<{ ok: boolean }>(`/api/v1/banking/items/${input.itemId}/match`, {
        journalEntryId: input.journalEntryId,
      }),
    onSuccess: () => {
      toast('success', 'Transaction matched');
      invalidateItems();
      setMatchTarget(null);
    },
  });

  const addItem = useMutation({
    mutationFn: (input: {
      itemId: string;
      splits: { accountId: string; amount: string; memo?: string }[];
      payeeName?: string;
    }) =>
      api.post<{ journalEntryId: string }>(`/api/v1/banking/items/${input.itemId}/add`, {
        splits: input.splits,
        payeeName: input.payeeName,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: () => {
      toast('success', 'Transaction added to the books');
      invalidateItems();
      setCategorizeTarget(null);
    },
  });

  const transferItem = useMutation({
    mutationFn: (input: { itemId: string; otherAccountId: string }) =>
      api.post<{ journalEntryId: string }>(`/api/v1/banking/items/${input.itemId}/transfer`, {
        otherAccountId: input.otherAccountId,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: () => {
      toast('success', 'Transfer recorded');
      invalidateItems();
      setTransferTarget(null);
    },
  });

  const setItemState = useMutation({
    mutationFn: (input: { itemId: string; state: 'excluded' | 'new' | 'needs_info' }) =>
      api.post<{ ok: boolean }>(`/api/v1/banking/items/${input.itemId}/state`, {
        state: input.state,
      }),
    onSuccess: (_data, input) => {
      toast(
        'success',
        input.state === 'excluded' ? 'Transaction excluded' : 'Transaction moved to review',
      );
      invalidateItems();
    },
    onError: (err) =>
      toast(
        'error',
        err instanceof ApiError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : 'Update failed',
      ),
  });

  // ----- categorize dialog math -----
  const categorizeAbsCents = categorizeTarget ? absCents(toCents(categorizeTarget.amount)) : 0n;
  const splitsTotalCents = splits.reduce((sum, s) => sum + toCents(s.amount), 0n);
  const splitsValid = splits.every((s) => s.accountId !== '' && toCents(s.amount) > 0n);
  const splitsBalanced = splitsTotalCents === categorizeAbsCents;
  const canAdd = categorizeTarget !== null && splitsValid && splitsBalanced;

  function openCategorize(item: BankItem) {
    addItem.reset();
    setSplits([emptySplit(centsToDecimalString(absCents(toCents(item.amount))))]);
    setPayeeName('');
    setCategorizeTarget(item);
  }

  function updateSplit(key: string, patch: Partial<SplitRow>) {
    setSplits((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  }

  const transferOtherOptions = accounts.filter(
    (a) => a.accountId !== (transferTarget?.accountId ?? activeAccountId),
  );

  const resolvedItems = useMemo(() => {
    const combined = [...(matchedItems.data?.items ?? []), ...(addedItems.data?.items ?? [])];
    return combined.sort((a, b) => (a.txnDate < b.txnDate ? 1 : a.txnDate > b.txnDate ? -1 : 0));
  }, [matchedItems.data, addedItems.data]);

  if (bankAccounts.isLoading) return <Spinner label="Loading bank accounts" />;
  if (bankAccounts.error) return <ErrorNote error={bankAccounts.error} />;

  return (
    <div>
      <PageHeader
        title="Bank transactions"
        description="Review imported bank and card activity, match it to existing entries, or add it to the books."
        actions={
          canImport && activeAccount ? (
            <Button
              onClick={() => {
                resetImport();
                setImportOpen(true);
              }}
            >
              Import statement (CSV)
            </Button>
          ) : undefined
        }
      />

      {accounts.length === 0 ? (
        <EmptyState
          title="No bank or card accounts"
          description="Add a bank or credit card account in the chart of accounts to start importing transactions."
        />
      ) : (
        <>
          <div
            className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
            role="group"
            aria-label="Select an account"
          >
            {accounts.map((a) => {
              const selected = a.accountId === activeAccountId;
              return (
                <button
                  key={a.accountId}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setSelectedAccountId(a.accountId)}
                  className={cn(
                    'rounded-lg border bg-card p-4 text-left shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    selected
                      ? 'border-primary ring-1 ring-primary'
                      : 'border-border hover:bg-muted/40',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium">{a.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {a.institutionName ?? 'No institution'}
                        {a.accountMask ? ` ••${a.accountMask}` : ''}
                      </p>
                    </div>
                    <Badge tone={a.kind === 'credit_card' ? 'warning' : 'info'}>
                      {a.kind === 'credit_card' ? 'Credit card' : 'Bank'}
                    </Badge>
                  </div>
                  <dl className="mt-3 space-y-1 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-muted-foreground">
                        {a.kind === 'credit_card' ? 'Amount owed (book balance)' : 'Book balance'}
                      </dt>
                      <dd data-money className="font-mono tabular-nums">
                        {formatMoney(a.bookBalance, currency)}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-muted-foreground">Cleared balance</dt>
                      <dd data-money className="font-mono tabular-nums">
                        {formatMoney(a.clearedBalance, currency)}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-muted-foreground">Reconciled through</dt>
                      <dd>{a.reconciledThrough ? formatDate(a.reconciledThrough) : 'Never'}</dd>
                    </div>
                  </dl>
                </button>
              );
            })}
          </div>

          <div
            className="mb-4 flex flex-wrap items-center gap-1"
            role="group"
            aria-label="Filter transactions by state"
          >
            {REVIEW_TABS.map((t) => (
              <Button
                key={t.key}
                variant={tab === t.key ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </Button>
            ))}
          </div>

          {tab === 'for_review' ? (
            forReviewItems.isLoading ? (
              <Spinner label="Loading transactions" />
            ) : forReviewItems.error ? (
              <ErrorNote error={forReviewItems.error} />
            ) : (forReviewItems.data?.items ?? []).length === 0 ? (
              <EmptyState
                title="Nothing to review"
                description="Imported transactions that need attention will appear here."
              />
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Date</TH>
                    <TH>Description</TH>
                    <TH>Reference</TH>
                    <TH className="text-right">Amount</TH>
                    <TH>State</TH>
                    {canPost ? <TH className="w-72">Actions</TH> : null}
                  </TR>
                </THead>
                <TBody>
                  {(forReviewItems.data?.items ?? []).map((item) => (
                    <TR key={item.id}>
                      <TD className="text-muted-foreground">{formatDate(item.txnDate)}</TD>
                      <TD>{item.description}</TD>
                      <TD className="text-muted-foreground">{item.reference ?? '—'}</TD>
                      <AmountCell amount={item.amount} currency={currency} />
                      <TD>
                        <StateBadge state={item.state} />
                      </TD>
                      {canPost ? (
                        <TD>
                          <div className="flex flex-wrap gap-1">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                matchItem.reset();
                                setMatchTarget(item);
                              }}
                            >
                              Match
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => openCategorize(item)}
                            >
                              Categorize
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                transferItem.reset();
                                setTransferOtherAccountId('');
                                setTransferTarget(item);
                              }}
                            >
                              Transfer
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              loading={
                                setItemState.isPending &&
                                setItemState.variables?.itemId === item.id &&
                                setItemState.variables?.state === 'excluded'
                              }
                              onClick={() =>
                                setItemState.mutate({ itemId: item.id, state: 'excluded' })
                              }
                            >
                              Exclude
                            </Button>
                            {item.state === 'possible_duplicate' ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                loading={
                                  setItemState.isPending &&
                                  setItemState.variables?.itemId === item.id &&
                                  setItemState.variables?.state === 'new'
                                }
                                onClick={() =>
                                  setItemState.mutate({ itemId: item.id, state: 'new' })
                                }
                              >
                                Not a duplicate
                              </Button>
                            ) : null}
                          </div>
                        </TD>
                      ) : null}
                    </TR>
                  ))}
                </TBody>
              </Table>
            )
          ) : tab === 'resolved' ? (
            matchedItems.isLoading || addedItems.isLoading ? (
              <Spinner label="Loading resolved transactions" />
            ) : matchedItems.error ? (
              <ErrorNote error={matchedItems.error} />
            ) : addedItems.error ? (
              <ErrorNote error={addedItems.error} />
            ) : resolvedItems.length === 0 ? (
              <EmptyState
                title="No resolved transactions"
                description="Matched and added transactions will appear here."
              />
            ) : (
              <ReadOnlyItemsTable items={resolvedItems} currency={currency} />
            )
          ) : excludedItems.isLoading ? (
            <Spinner label="Loading excluded transactions" />
          ) : excludedItems.error ? (
            <ErrorNote error={excludedItems.error} />
          ) : (excludedItems.data?.items ?? []).length === 0 ? (
            <EmptyState
              title="No excluded transactions"
              description="Transactions you exclude from the books will appear here."
            />
          ) : (
            <ReadOnlyItemsTable items={excludedItems.data?.items ?? []} currency={currency} />
          )}
        </>
      )}

      {/* ----- import dialog ----- */}
      <Dialog
        open={importOpen}
        onOpenChange={(open) => {
          setImportOpen(open);
          if (!open) resetImport();
        }}
        title="Import statement (CSV)"
        description={
          activeAccount
            ? `Import bank statement rows into ${activeAccount.name}. Nothing posts to the ledger until you review each transaction.`
            : undefined
        }
        wide
      >
        <div className="space-y-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Step {importStep} of 3:{' '}
            {importStep === 1
              ? 'Choose a file'
              : importStep === 2
                ? 'Map the columns'
                : 'Review and import'}
          </p>

          {importStep === 1 ? (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="import-file">CSV file</Label>
                <input
                  id="import-file"
                  type="file"
                  accept=".csv"
                  onChange={onFileChange}
                  className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-secondary-foreground hover:file:bg-secondary/80"
                />
                {filename !== '' ? (
                  <p className="text-xs text-muted-foreground">
                    Loaded {filename} (
                    {csvContent.split(/\r?\n/).filter((l) => l.trim() !== '').length} lines).
                  </p>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="import-paste">Or paste CSV text</Label>
                <Textarea
                  id="import-paste"
                  className="min-h-[120px] font-mono text-xs"
                  placeholder="Date,Description,Amount"
                  value={pasted}
                  onChange={(e) => {
                    setPasted(e.target.value);
                    setCsvContent(e.target.value);
                    setFilename('');
                  }}
                />
              </div>
              <div className="flex justify-end">
                <Button disabled={csvContent.trim() === ''} onClick={() => setImportStep(2)}>
                  Next: map columns
                </Button>
              </div>
            </div>
          ) : null}

          {importStep === 2 ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2 text-sm" htmlFor="import-has-header">
                  <input
                    id="import-has-header"
                    type="checkbox"
                    className="h-4 w-4 rounded border-input"
                    checked={hasHeader}
                    onChange={(e) => setHasHeader(e.target.checked)}
                  />
                  First row is a header
                </label>
                <div className="flex items-center gap-2">
                  <Label htmlFor="import-date-format">Date format</Label>
                  <Select
                    id="import-date-format"
                    className="w-auto"
                    value={dateFormat}
                    onChange={(e) => setDateFormat(e.target.value as DateFormat)}
                  >
                    <option value="MDY">Month / Day / Year</option>
                    <option value="DMY">Day / Month / Year</option>
                    <option value="YMD">Year / Month / Day</option>
                  </Select>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="import-col-date">Date column</Label>
                  <Select
                    id="import-col-date"
                    required
                    value={dateColumn}
                    onChange={(e) => setDateColumn(e.target.value)}
                  >
                    <option value="" disabled>
                      Select a column…
                    </option>
                    {columnOptions.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="import-col-desc">Description column</Label>
                  <Select
                    id="import-col-desc"
                    required
                    value={descriptionColumn}
                    onChange={(e) => setDescriptionColumn(e.target.value)}
                  >
                    <option value="" disabled>
                      Select a column…
                    </option>
                    {columnOptions.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="import-col-ref">Reference column (optional)</Label>
                  <Select
                    id="import-col-ref"
                    value={referenceColumn}
                    onChange={(e) => setReferenceColumn(e.target.value)}
                  >
                    <option value="">No reference column</option>
                    {columnOptions.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>

              <fieldset className="space-y-3 rounded-md border border-border p-3">
                <legend className="px-1 text-sm font-medium">Amounts</legend>
                <div className="flex flex-wrap gap-4 text-sm">
                  <label className="flex items-center gap-2" htmlFor="import-amount-single">
                    <input
                      id="import-amount-single"
                      type="radio"
                      name="amount-mode"
                      className="h-4 w-4 border-input"
                      checked={amountMode === 'single'}
                      onChange={() => setAmountMode('single')}
                    />
                    One signed amount column
                  </label>
                  <label className="flex items-center gap-2" htmlFor="import-amount-split">
                    <input
                      id="import-amount-split"
                      type="radio"
                      name="amount-mode"
                      className="h-4 w-4 border-input"
                      checked={amountMode === 'split'}
                      onChange={() => setAmountMode('split')}
                    />
                    Separate debit and credit columns
                  </label>
                </div>
                {amountMode === 'single' ? (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="import-col-amount">Amount column</Label>
                      <Select
                        id="import-col-amount"
                        required
                        value={amountColumn}
                        onChange={(e) => setAmountColumn(e.target.value)}
                      >
                        <option value="" disabled>
                          Select a column…
                        </option>
                        {columnOptions.map((c) => (
                          <option key={c.value} value={c.value}>
                            {c.label}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <label
                      className="flex items-center gap-2 self-end pb-2 text-sm"
                      htmlFor="import-positive-in"
                    >
                      <input
                        id="import-positive-in"
                        type="checkbox"
                        className="h-4 w-4 rounded border-input"
                        checked={positiveIsMoneyIn}
                        onChange={(e) => setPositiveIsMoneyIn(e.target.checked)}
                      />
                      Positive amounts are money in
                    </label>
                  </div>
                ) : (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="import-col-debit">Debit (money out) column</Label>
                      <Select
                        id="import-col-debit"
                        required
                        value={debitColumn}
                        onChange={(e) => setDebitColumn(e.target.value)}
                      >
                        <option value="" disabled>
                          Select a column…
                        </option>
                        {columnOptions.map((c) => (
                          <option key={c.value} value={c.value}>
                            {c.label}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="import-col-credit">Credit (money in) column</Label>
                      <Select
                        id="import-col-credit"
                        required
                        value={creditColumn}
                        onChange={(e) => setCreditColumn(e.target.value)}
                      >
                        <option value="" disabled>
                          Select a column…
                        </option>
                        {columnOptions.map((c) => (
                          <option key={c.value} value={c.value}>
                            {c.label}
                          </option>
                        ))}
                      </Select>
                    </div>
                  </div>
                )}
              </fieldset>

              {dryRun.error ? <ApiErrorNote error={dryRun.error} /> : null}

              <div className="flex items-center justify-between gap-3">
                <Button variant="outline" onClick={() => setImportStep(1)}>
                  Back
                </Button>
                <Button
                  disabled={!mappingComplete}
                  loading={dryRun.isPending}
                  onClick={() => dryRun.mutate()}
                >
                  Next: dry run
                </Button>
              </div>
            </div>
          ) : null}

          {importStep === 3 && dryRun.data ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-4">
                <SummaryStat label="Rows" value={dryRun.data.rowCount} />
                <SummaryStat label="Will import" value={dryRun.data.importedCount} />
                <SummaryStat label="Duplicates skipped" value={dryRun.data.duplicateCount} />
                <SummaryStat label="Errors" value={dryRun.data.errorCount} />
              </div>

              {dryRun.data.errors.length > 0 ? (
                <div className="space-y-1">
                  <p className="text-sm font-medium text-destructive">Row errors</p>
                  <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive">
                    {dryRun.data.errors.map((err) => (
                      <li key={`${err.row}-${err.message}`}>
                        Row {err.row}: {err.message}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {dryRun.data.preview.length > 0 ? (
                <div className="space-y-1">
                  <p className="text-sm font-medium">Preview</p>
                  <Table>
                    <THead>
                      <TR>
                        <TH className="w-14">Row</TH>
                        <TH>Date</TH>
                        <TH>Description</TH>
                        <TH>Reference</TH>
                        <TH className="text-right">Amount</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {dryRun.data.preview.map((row) => (
                        <TR key={row.rowNumber}>
                          <TD className="text-muted-foreground">{row.rowNumber}</TD>
                          <TD>{formatDate(row.date)}</TD>
                          <TD>{row.description}</TD>
                          <TD className="text-muted-foreground">{row.reference ?? '—'}</TD>
                          <AmountCell amount={row.amount} currency={currency} />
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No importable rows were found.</p>
              )}

              {executeImport.error ? <ApiErrorNote error={executeImport.error} /> : null}

              <div className="flex items-center justify-between gap-3">
                <Button
                  variant="outline"
                  onClick={() => {
                    dryRun.reset();
                    executeImport.reset();
                    setImportStep(2);
                  }}
                >
                  Back
                </Button>
                <Button
                  disabled={dryRun.data.importedCount === 0}
                  loading={executeImport.isPending}
                  onClick={() => executeImport.mutate()}
                >
                  Import {dryRun.data.importedCount}{' '}
                  {dryRun.data.importedCount === 1 ? 'transaction' : 'transactions'}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </Dialog>

      {/* ----- match dialog ----- */}
      <Dialog
        open={matchTarget !== null}
        onOpenChange={(open) => {
          if (!open) setMatchTarget(null);
        }}
        title="Match to an existing entry"
        description={
          matchTarget
            ? `${formatDate(matchTarget.txnDate)} · ${matchTarget.description} · ${formatMoney(matchTarget.amount, currency)}`
            : undefined
        }
        wide
      >
        {suggestions.isLoading ? (
          <Spinner label="Loading suggestions" />
        ) : suggestions.error ? (
          <ErrorNote error={suggestions.error} />
        ) : (suggestions.data?.items ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No matching journal entries were found. Use Categorize to add this transaction instead.
          </p>
        ) : (
          <div className="space-y-4">
            <Table>
              <THead>
                <TR>
                  <TH>Entry #</TH>
                  <TH>Date</TH>
                  <TH>Source</TH>
                  <TH>Memo</TH>
                  <TH className="text-right">Amount</TH>
                  <TH className="w-24">
                    <span className="sr-only">Match action</span>
                  </TH>
                </TR>
              </THead>
              <TBody>
                {(suggestions.data?.items ?? []).map((s) => (
                  <TR key={s.lineId}>
                    <TD className="font-mono text-[13px]">{s.entryNumber}</TD>
                    <TD className="text-muted-foreground">{formatDate(s.postingDate)}</TD>
                    <TD className="text-muted-foreground">{s.sourceType}</TD>
                    <TD>{s.memo ?? '—'}</TD>
                    <TDMoney>{formatMoney(s.amount, currency)}</TDMoney>
                    <TD>
                      <Button
                        variant="outline"
                        size="sm"
                        loading={
                          matchItem.isPending &&
                          matchItem.variables?.journalEntryId === s.journalEntryId
                        }
                        onClick={() => {
                          if (!matchTarget) return;
                          matchItem.mutate({
                            itemId: matchTarget.id,
                            journalEntryId: s.journalEntryId,
                          });
                        }}
                      >
                        Match
                      </Button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            {matchItem.error ? <ApiErrorNote error={matchItem.error} /> : null}
          </div>
        )}
      </Dialog>

      {/* ----- categorize dialog ----- */}
      <Dialog
        open={categorizeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setCategorizeTarget(null);
        }}
        title="Categorize transaction"
        description={
          categorizeTarget
            ? `${formatDate(categorizeTarget.txnDate)} · ${categorizeTarget.description} · ${formatMoney(categorizeTarget.amount, currency)}. Splits must add up to ${formatMoney(centsToDecimalString(categorizeAbsCents), currency)}.`
            : undefined
        }
        wide
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!categorizeTarget || !canAdd) return;
            addItem.mutate({
              itemId: categorizeTarget.id,
              splits: splits.map((s) => ({
                accountId: s.accountId,
                amount: centsToDecimalString(toCents(s.amount)),
                memo: s.memo.trim() !== '' ? s.memo.trim() : undefined,
              })),
              payeeName: payeeName.trim() !== '' ? payeeName.trim() : undefined,
            });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="cat-payee">Payee (optional)</Label>
            <Input
              id="cat-payee"
              value={payeeName}
              onChange={(e) => setPayeeName(e.target.value)}
            />
          </div>

          <Table>
            <THead>
              <TR>
                <TH>Category account</TH>
                <TH>Memo</TH>
                <TH className="w-32 text-right">Amount</TH>
                <TH className="w-12">
                  <span className="sr-only">Remove split</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {splits.map((s, idx) => (
                <TR key={s.key}>
                  <TD>
                    <Select
                      aria-label={`Category account for split ${idx + 1}`}
                      required
                      value={s.accountId}
                      onChange={(e) => updateSplit(s.key, { accountId: e.target.value })}
                    >
                      <option value="" disabled>
                        Select an account…
                      </option>
                      {categoryAccountOptions.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.number ? `${a.number} · ${a.name}` : a.name}
                        </option>
                      ))}
                    </Select>
                  </TD>
                  <TD>
                    <Input
                      aria-label={`Memo for split ${idx + 1}`}
                      value={s.memo}
                      onChange={(e) => updateSplit(s.key, { memo: e.target.value })}
                    />
                  </TD>
                  <TD>
                    <MoneyInput
                      aria-label={`Amount for split ${idx + 1}`}
                      placeholder="0.00"
                      value={s.amount}
                      onChange={(e) => {
                        if (PRICE_PATTERN.test(e.target.value)) {
                          updateSplit(s.key, { amount: e.target.value });
                        }
                      }}
                    />
                  </TD>
                  <TD>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove split ${idx + 1}`}
                      disabled={splits.length <= 1}
                      onClick={() =>
                        setSplits((prev) =>
                          prev.length > 1 ? prev.filter((x) => x.key !== s.key) : prev,
                        )
                      }
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>

          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <Button variant="outline" onClick={() => setSplits((prev) => [...prev, emptySplit()])}>
              Add split
            </Button>
            <span className={splitsBalanced ? 'text-muted-foreground' : 'text-destructive'}>
              Splits:{' '}
              <span data-money className="font-mono tabular-nums">
                {formatMoney(centsToDecimalString(splitsTotalCents), currency)}
              </span>{' '}
              of{' '}
              <span data-money className="font-mono tabular-nums">
                {formatMoney(centsToDecimalString(categorizeAbsCents), currency)}
              </span>
            </span>
          </div>

          {addItem.error ? <ApiErrorNote error={addItem.error} /> : null}

          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {!canAdd
                ? !splitsValid
                  ? 'Every split needs an account and an amount greater than zero.'
                  : 'Splits must add up exactly to the transaction amount.'
                : 'Ready to add.'}
            </p>
            <Button type="submit" disabled={!canAdd} loading={addItem.isPending}>
              Add to books
            </Button>
          </div>
        </form>
      </Dialog>

      {/* ----- transfer dialog ----- */}
      <Dialog
        open={transferTarget !== null}
        onOpenChange={(open) => {
          if (!open) setTransferTarget(null);
        }}
        title="Record as transfer"
        description={
          transferTarget
            ? `${formatDate(transferTarget.txnDate)} · ${transferTarget.description} · ${formatMoney(transferTarget.amount, currency)}. Records the movement between this account and the one you choose.`
            : undefined
        }
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!transferTarget || transferOtherAccountId === '') return;
            transferItem.mutate({
              itemId: transferTarget.id,
              otherAccountId: transferOtherAccountId,
            });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="transfer-other">Other account</Label>
            <Select
              id="transfer-other"
              required
              value={transferOtherAccountId}
              onChange={(e) => setTransferOtherAccountId(e.target.value)}
            >
              <option value="" disabled>
                Select a bank or card account…
              </option>
              {transferOtherOptions.map((a) => (
                <option key={a.accountId} value={a.accountId}>
                  {a.name}
                  {a.accountMask ? ` ••${a.accountMask}` : ''}
                </option>
              ))}
            </Select>
          </div>
          {transferItem.error ? <ApiErrorNote error={transferItem.error} /> : null}
          <Button
            type="submit"
            className="w-full"
            disabled={transferOtherAccountId === ''}
            loading={transferItem.isPending}
          >
            Record transfer
          </Button>
        </form>
      </Dialog>
    </div>
  );
}

function SummaryStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

/** Read-only listing used by the Resolved and Excluded tabs. */
function ReadOnlyItemsTable({ items, currency }: { items: BankItem[]; currency: string }) {
  return (
    <Table>
      <THead>
        <TR>
          <TH>Date</TH>
          <TH>Description</TH>
          <TH>Reference</TH>
          <TH className="text-right">Amount</TH>
          <TH>State</TH>
        </TR>
      </THead>
      <TBody>
        {items.map((item) => (
          <TR key={item.id}>
            <TD className="text-muted-foreground">{formatDate(item.txnDate)}</TD>
            <TD>{item.description}</TD>
            <TD className="text-muted-foreground">{item.reference ?? '—'}</TD>
            <AmountCell amount={item.amount} currency={currency} />
            <TD>
              <StateBadge state={item.state} />
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
