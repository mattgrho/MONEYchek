import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import type { Me } from '@/lib/types';
import { can } from '@/lib/types';
import { cn, formatDate, formatMoney, todayISO } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input, MoneyInput } from '@/components/ui/input';
import { Dialog } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import {
  Badge,
  Card,
  CardContent,
  EmptyState,
  ErrorNote,
  Label,
  PageHeader,
  Select,
  Spinner,
} from '@/components/ui/primitives';
import { Table, TBody, TD, TDMoney, TH, THead, TR } from '@/components/ui/table';

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
  /** Signed ledger value of the prior reconciliation's ending balance. */
  lastStatementBalance: string | null;
}

interface ReconciliationListItem {
  id: string;
  accountId: string;
  accountName: string;
  statementStartDate: string;
  statementEndDate: string;
  beginningBalance: string;
  endingBalance: string;
  status: 'in_progress' | 'completed';
  completedAt: string | null;
  hasDiscrepancy: boolean;
}

interface CandidateLine {
  lineId: string;
  entryId: string;
  entryNumber: string;
  postingDate: string;
  sourceType: string;
  memo: string | null;
  debit: string;
  credit: string;
  cleared: boolean;
  reconciliationId: string | null;
  runningBalance: string;
}

interface ReconciliationStatus {
  reconciliation: {
    id: string;
    accountId: string;
    statementStartDate: string;
    statementEndDate: string;
    beginningBalance: string;
    endingBalance: string;
    status: 'in_progress' | 'completed';
  };
  clearedDebits: string;
  clearedCredits: string;
  clearedEnding: string;
  difference: string;
  selectedLineIds: string[];
}

interface ReconciliationDetail extends ReconciliationStatus {
  candidateLines: CandidateLine[];
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

/** Flips the sign of a decimal string ('175.00' <-> '-175.00'); zero stays '0.00'. */
function negateMoney(value: string): string {
  return centsToDecimalString(-toCents(value));
}

/** Signed 2dp money, optional leading minus (used for bank-account balances). */
const SIGNED_MONEY_PATTERN = /^-?\d*(\.\d{0,2})?$/;
/** Unsigned 2dp money (used for credit-card 'amount owed' inputs). */
const UNSIGNED_MONEY_PATTERN = /^\d*(\.\d{0,2})?$/;

function isCompleteMoney(value: string): boolean {
  return /^-?\d+(\.\d{1,2})?$/.test(value.trim()) || /^-?\.\d{1,2}$/.test(value.trim());
}

/** 'invoice' -> 'Invoice', 'bill_payment' -> 'Bill payment'. */
function sourceTypeLabel(sourceType: string): string {
  const words = sourceType.replace(/_/g, ' ').trim();
  return words === '' ? '—' : words.charAt(0).toUpperCase() + words.slice(1);
}

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

function accountOptionLabel(a: BankingAccount): string {
  const base = a.number ? `${a.number} · ${a.name}` : a.name;
  const suffix =
    a.institutionName || a.accountMask
      ? ` (${[a.institutionName, a.accountMask ? `···${a.accountMask}` : null]
          .filter(Boolean)
          .join(' ')})`
      : '';
  return `${base}${suffix}`;
}

export function ReconcilePage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const currency = me.company?.homeCurrency ?? 'USD';
  const canCreate = can(me, 'reconciliations.create');
  const canReconcile = can(me, 'reconciliations.reconcile');

  const [activeId, setActiveId] = useState<string | null>(null);

  // ----- start-reconciliation dialog state -----
  const [formOpen, setFormOpen] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState(todayISO());
  const [beginningBalance, setBeginningBalance] = useState('0.00');
  const [endingBalance, setEndingBalance] = useState('');

  // ----- abandon confirm dialog -----
  const [abandonOpen, setAbandonOpen] = useState(false);

  const recons = useQuery({
    queryKey: ['reconciliations'],
    queryFn: () => api.get<{ items: ReconciliationListItem[] }>('/api/v1/reconciliations'),
  });
  const bankAccounts = useQuery({
    queryKey: ['banking-accounts'],
    queryFn: () => api.get<{ items: BankingAccount[] }>('/api/v1/banking/accounts'),
  });
  const detail = useQuery({
    queryKey: ['reconciliation', activeId],
    queryFn: () => api.get<ReconciliationDetail>(`/api/v1/reconciliations/${activeId}`),
    enabled: activeId !== null,
  });

  const accountItems = bankAccounts.data?.items ?? [];
  const kindByAccount = new Map(accountItems.map((a) => [a.accountId, a.kind]));
  const selectedAccount = accountItems.find((a) => a.accountId === accountId) ?? null;
  const formIsCard = selectedAccount?.kind === 'credit_card';

  /** Displays a signed ledger value; credit cards show positive amount owed. */
  function displayBalance(value: string, forAccountId: string): string {
    return kindByAccount.get(forAccountId) === 'credit_card' ? negateMoney(value) : value;
  }

  function selectAccount(nextId: string) {
    setAccountId(nextId);
    const acct = accountItems.find((a) => a.accountId === nextId);
    if (!acct) {
      setBeginningBalance('0.00');
      return;
    }
    const prior = acct.lastStatementBalance ?? '0.00';
    setBeginningBalance(acct.kind === 'credit_card' ? negateMoney(prior) : prior);
  }

  function resetForm() {
    setAccountId('');
    setStartDate('');
    setEndDate(todayISO());
    setBeginningBalance('0.00');
    setEndingBalance('');
  }

  const balancePattern = formIsCard ? UNSIGNED_MONEY_PATTERN : SIGNED_MONEY_PATTERN;
  const canStart =
    accountId !== '' &&
    startDate !== '' &&
    endDate !== '' &&
    startDate <= endDate &&
    isCompleteMoney(beginningBalance) &&
    isCompleteMoney(endingBalance);

  const startRecon = useMutation({
    mutationFn: () => {
      // Credit cards: users type positive 'amount owed'; the ledger stores the
      // signed (negative) liability value, so negate before sending.
      const begin = centsToDecimalString(toCents(beginningBalance));
      const end = centsToDecimalString(toCents(endingBalance));
      return api.post<{ id: string }>('/api/v1/reconciliations', {
        accountId,
        statementStartDate: startDate,
        statementEndDate: endDate,
        beginningBalance: formIsCard ? negateMoney(begin) : begin,
        endingBalance: formIsCard ? negateMoney(end) : end,
      });
    },
    onSuccess: (data) => {
      toast('success', 'Reconciliation started');
      void qc.invalidateQueries({ queryKey: ['reconciliations'] });
      setFormOpen(false);
      resetForm();
      setActiveId(data.id);
    },
  });

  const toggle = useMutation({
    mutationFn: (input: { journalLineId: string; selected: boolean }) =>
      api.post<ReconciliationStatus>(`/api/v1/reconciliations/${activeId}/toggle`, input),
    onSuccess: (data) => {
      // The toggle response is the status without candidateLines; merge it so
      // the summary updates without refetching the whole candidate list.
      qc.setQueryData<ReconciliationDetail>(['reconciliation', activeId], (old) =>
        old ? { ...old, ...data } : old,
      );
    },
    onError: (err) =>
      toast(
        'error',
        err instanceof ApiError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : 'Toggle failed',
      ),
  });

  const complete = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean }>(`/api/v1/reconciliations/${activeId}/complete`, {
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: () => {
      toast('success', 'Reconciliation completed');
      void qc.invalidateQueries({ queryKey: ['reconciliations'] });
      void qc.invalidateQueries({ queryKey: ['reconciliation'] });
      void qc.invalidateQueries({ queryKey: ['banking-accounts'] });
      setActiveId(null);
    },
  });

  const abandon = useMutation({
    mutationFn: () => api.delete<{ ok: boolean }>(`/api/v1/reconciliations/${activeId}`),
    onSuccess: () => {
      toast('success', 'Reconciliation abandoned');
      void qc.invalidateQueries({ queryKey: ['reconciliations'] });
      void qc.invalidateQueries({ queryKey: ['reconciliation'] });
      setAbandonOpen(false);
      setActiveId(null);
    },
  });

  if (recons.isLoading) return <Spinner label="Loading reconciliations" />;
  if (recons.error) return <ErrorNote error={recons.error} />;

  const items = recons.data?.items ?? [];

  // ----- active reconciliation derived values -----
  const active = activeId !== null ? detail.data : undefined;
  const activeAccountId = active?.reconciliation.accountId ?? '';
  const activeIsCard = kindByAccount.get(activeAccountId) === 'credit_card';
  const activeAccountName =
    items.find((r) => r.id === activeId)?.accountName ??
    accountItems.find((a) => a.accountId === activeAccountId)?.name ??
    'account';
  const selectedSet = new Set(active?.selectedLineIds ?? []);
  const differenceCents = active ? toCents(active.difference) : null;
  const balanced = differenceCents === 0n;

  return (
    <div>
      <PageHeader
        title="Reconcile"
        description="Match your books to bank and credit-card statements. Completing a reconciliation marks the selected transactions as reconciled."
        actions={
          canCreate ? (
            <Button
              onClick={() => {
                startRecon.reset();
                resetForm();
                setFormOpen(true);
              }}
            >
              Start reconciliation
            </Button>
          ) : undefined
        }
      />

      {/* ----- active reconciliation view ----- */}
      {activeId !== null ? (
        detail.isLoading ? (
          <Spinner label="Loading reconciliation" />
        ) : detail.error ? (
          <div className="mb-6 space-y-3">
            <ErrorNote error={detail.error} />
            <Button variant="outline" size="sm" onClick={() => setActiveId(null)}>
              Back to history
            </Button>
          </div>
        ) : active ? (
          <Card className="mb-6">
            <CardContent className="space-y-4 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold">Reconciling {activeAccountName}</h2>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    Statement {formatDate(active.reconciliation.statementStartDate)} –{' '}
                    {formatDate(active.reconciliation.statementEndDate)} · Beginning{' '}
                    {formatMoney(
                      displayBalance(active.reconciliation.beginningBalance, activeAccountId),
                      currency,
                    )}
                    {activeIsCard ? ' owed' : ''}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setActiveId(null)}>
                    Back to history
                  </Button>
                  {canReconcile && active.reconciliation.status === 'in_progress' ? (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive"
                        onClick={() => {
                          abandon.reset();
                          setAbandonOpen(true);
                        }}
                      >
                        Abandon
                      </Button>
                      <Button
                        size="sm"
                        disabled={!balanced}
                        loading={complete.isPending}
                        onClick={() => complete.mutate()}
                      >
                        Finish reconciliation
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>

              {/* summary bar */}
              <div className="grid gap-3 rounded-md border border-border bg-muted/40 p-3 sm:grid-cols-3">
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    {activeIsCard ? 'Statement amount owed' : 'Statement ending'}
                  </p>
                  <p data-money className="font-mono text-sm font-semibold tabular-nums">
                    {formatMoney(
                      displayBalance(active.reconciliation.endingBalance, activeAccountId),
                      currency,
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    {activeIsCard ? 'Cleared amount owed' : 'Cleared ending'}
                  </p>
                  <p data-money className="font-mono text-sm font-semibold tabular-nums">
                    {formatMoney(displayBalance(active.clearedEnding, activeAccountId), currency)}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Difference
                  </p>
                  <p
                    data-money
                    className={cn(
                      'font-mono text-sm font-semibold tabular-nums',
                      balanced ? 'text-success' : 'text-destructive',
                    )}
                  >
                    {formatMoney(displayBalance(active.difference, activeAccountId), currency)}
                  </p>
                </div>
              </div>

              {!balanced ? (
                <p className="text-xs text-muted-foreground">
                  Check off the transactions that appear on the statement until the difference is
                  zero, then finish the reconciliation.
                </p>
              ) : (
                <p className="text-xs text-success">
                  The books match the statement. You can finish the reconciliation.
                </p>
              )}

              {complete.error ? <ApiErrorNote error={complete.error} /> : null}

              {active.candidateLines.length === 0 ? (
                <EmptyState
                  title="No transactions to reconcile"
                  description="There are no posted transactions in this account through the statement end date."
                />
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH className="w-12">Clear</TH>
                      <TH>Date</TH>
                      <TH>Entry #</TH>
                      <TH>Source</TH>
                      <TH>Memo</TH>
                      <TH className="text-right">Debit</TH>
                      <TH className="text-right">Credit</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {active.candidateLines.map((line) => {
                      const checked = selectedSet.has(line.lineId);
                      const pendingThis =
                        toggle.isPending && toggle.variables?.journalLineId === line.lineId;
                      return (
                        <TR key={line.lineId}>
                          <TD className="text-center">
                            <input
                              type="checkbox"
                              aria-label={`Mark entry ${line.entryNumber} on ${formatDate(line.postingDate)} as cleared`}
                              className="h-4 w-4 rounded border-input"
                              checked={checked}
                              disabled={
                                !canReconcile ||
                                active.reconciliation.status !== 'in_progress' ||
                                pendingThis
                              }
                              onChange={(e) =>
                                toggle.mutate({
                                  journalLineId: line.lineId,
                                  selected: e.target.checked,
                                })
                              }
                            />
                          </TD>
                          <TD className="text-muted-foreground">{formatDate(line.postingDate)}</TD>
                          <TD className="font-mono text-[13px]">{line.entryNumber}</TD>
                          <TD>{sourceTypeLabel(line.sourceType)}</TD>
                          <TD className="max-w-[280px] truncate text-muted-foreground">
                            {line.memo ?? '—'}
                          </TD>
                          <TDMoney>
                            {toCents(line.debit) !== 0n ? formatMoney(line.debit, currency) : '—'}
                          </TDMoney>
                          <TDMoney>
                            {toCents(line.credit) !== 0n ? formatMoney(line.credit, currency) : '—'}
                          </TDMoney>
                        </TR>
                      );
                    })}
                  </TBody>
                </Table>
              )}
            </CardContent>
          </Card>
        ) : null
      ) : null}

      {/* ----- history ----- */}
      {items.length === 0 ? (
        <EmptyState
          title="No reconciliations yet"
          description="Start a reconciliation to match an account against its statement."
          action={
            canCreate ? (
              <Button
                onClick={() => {
                  startRecon.reset();
                  resetForm();
                  setFormOpen(true);
                }}
              >
                Start reconciliation
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Account</TH>
              <TH>Statement period</TH>
              <TH className="text-right">Beginning</TH>
              <TH className="text-right">Ending</TH>
              <TH>Status</TH>
              <TH>Completed</TH>
              <TH className="w-28">
                <span className="sr-only">Actions</span>
              </TH>
            </TR>
          </THead>
          <TBody>
            {items.map((r) => (
              <TR key={r.id}>
                <TD className="font-medium">{r.accountName}</TD>
                <TD className="text-muted-foreground">
                  {formatDate(r.statementStartDate)} – {formatDate(r.statementEndDate)}
                </TD>
                <TDMoney>
                  {formatMoney(displayBalance(r.beginningBalance, r.accountId), currency)}
                </TDMoney>
                <TDMoney>
                  {formatMoney(displayBalance(r.endingBalance, r.accountId), currency)}
                </TDMoney>
                <TD>
                  <span className="flex flex-wrap gap-1">
                    <Badge tone={r.status === 'completed' ? 'success' : 'warning'}>
                      {r.status === 'completed' ? 'Completed' : 'In progress'}
                    </Badge>
                    {r.hasDiscrepancy ? <Badge tone="danger">Discrepancy</Badge> : null}
                  </span>
                </TD>
                <TD className="text-muted-foreground">
                  {r.completedAt ? formatDate(r.completedAt) : '—'}
                </TD>
                <TD>
                  {r.status === 'in_progress' ? (
                    <Button variant="outline" size="sm" onClick={() => setActiveId(r.id)}>
                      {activeId === r.id ? 'Viewing' : 'Resume'}
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      {/* ----- start reconciliation dialog ----- */}
      <Dialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) resetForm();
        }}
        title="Start reconciliation"
        description="Enter the statement period and balances, then check off the transactions that appear on the statement."
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            startRecon.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="recon-account">Account</Label>
            {bankAccounts.isLoading ? (
              <Spinner label="Loading accounts" />
            ) : bankAccounts.error ? (
              <ErrorNote error={bankAccounts.error} />
            ) : (
              <Select
                id="recon-account"
                required
                value={accountId}
                onChange={(e) => selectAccount(e.target.value)}
              >
                <option value="" disabled>
                  Select an account…
                </option>
                {accountItems.map((a) => (
                  <option key={a.accountId} value={a.accountId}>
                    {accountOptionLabel(a)}
                  </option>
                ))}
              </Select>
            )}
            {formIsCard ? (
              <p className="text-xs text-muted-foreground">
                Credit card: enter balances as the positive amount owed shown on the statement.
              </p>
            ) : null}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="recon-start">Statement start date</Label>
              <Input
                id="recon-start"
                type="date"
                required
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="recon-end">Statement end date</Label>
              <Input
                id="recon-end"
                type="date"
                required
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="recon-beginning">
                {formIsCard ? 'Beginning amount owed' : 'Beginning balance'}
              </Label>
              <MoneyInput
                id="recon-beginning"
                required
                placeholder="0.00"
                value={beginningBalance}
                onChange={(e) => {
                  if (balancePattern.test(e.target.value)) setBeginningBalance(e.target.value);
                }}
              />
              <p className="text-xs text-muted-foreground">
                Must equal the prior reconciliation&apos;s ending balance (0.00 for a first
                reconciliation).
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="recon-ending">
                {formIsCard ? 'Ending amount owed' : 'Ending balance'}
              </Label>
              <MoneyInput
                id="recon-ending"
                required
                placeholder="0.00"
                value={endingBalance}
                onChange={(e) => {
                  if (balancePattern.test(e.target.value)) setEndingBalance(e.target.value);
                }}
              />
            </div>
          </div>

          {startRecon.error ? <ApiErrorNote error={startRecon.error} /> : null}

          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {!canStart
                ? 'An account, a statement period, and both balances are required.'
                : 'Ready to start.'}
            </p>
            <Button type="submit" disabled={!canStart} loading={startRecon.isPending}>
              Start reconciliation
            </Button>
          </div>
        </form>
      </Dialog>

      {/* ----- abandon confirm dialog ----- */}
      <Dialog
        open={abandonOpen}
        onOpenChange={(open) => {
          if (!open) setAbandonOpen(false);
        }}
        title="Abandon reconciliation"
        description="Discards this in-progress reconciliation. Nothing has posted, and cleared checkmarks made here are released."
      >
        <div className="space-y-4">
          {abandon.error ? <ApiErrorNote error={abandon.error} /> : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setAbandonOpen(false)}>
              Keep working
            </Button>
            <Button
              variant="destructive"
              loading={abandon.isPending}
              onClick={() => abandon.mutate()}
            >
              Abandon reconciliation
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
