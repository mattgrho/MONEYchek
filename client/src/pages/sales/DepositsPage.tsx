import { useState } from 'react';
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
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorNote,
  Label,
  PageHeader,
  Select,
  Spinner,
} from '@/components/ui/primitives';
import { Table, TBody, TD, TDMoney, TFoot, TH, THead, TR } from '@/components/ui/table';

interface UndepositedReceipt {
  sourceType: string;
  sourceId: string;
  number: string;
  date: string;
  partyName: string | null;
  amount: string;
}

interface DepositComponent {
  sourceType: string | null;
  sourceId: string | null;
  accountId: string;
  description: string | null;
  amount: string;
}

interface Deposit {
  id: string;
  number: string;
  postingStatus: 'draft' | 'posted' | 'voided' | 'reversed';
  depositDate: string;
  bankAccountId: string;
  memo: string | null;
  total: string;
  components: DepositComponent[];
}

interface Account {
  id: string;
  number: string | null;
  name: string;
  category: string;
  detailType: string | null;
  systemKey: string | null;
  bankKind: string | null;
  active: boolean;
}

const STATUS_TONES: Record<Deposit['postingStatus'], 'neutral' | 'success' | 'warning' | 'danger'> =
  {
    draft: 'neutral',
    posted: 'success',
    voided: 'danger',
    reversed: 'warning',
  };

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

function receiptKey(r: { sourceType: string; sourceId: string }): string {
  return `${r.sourceType}:${r.sourceId}`;
}

function sourceTypeLabel(sourceType: string | null): string {
  if (sourceType === 'payment') return 'Payment';
  if (sourceType === 'sales_receipt') return 'Sales receipt';
  if (sourceType === null) return 'Other funds';
  return sourceType.replace(/_/g, ' ');
}

/** 'Other funds' grid row state for the deposit form. */
interface OtherLine {
  key: string;
  accountId: string;
  amount: string;
  description: string;
}

function emptyOtherLine(): OtherLine {
  return { key: crypto.randomUUID(), accountId: '', amount: '', description: '' };
}

function otherLineIsComplete(l: OtherLine): boolean {
  return l.accountId !== '' && PRICE_PATTERN.test(l.amount.trim()) && toCents(l.amount) > 0n;
}

function otherLineIsBlank(l: OtherLine): boolean {
  return l.accountId === '' && l.amount.trim() === '' && l.description.trim() === '';
}

export function DepositsPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const currency = me.company?.homeCurrency ?? 'USD';
  const canCreate = can(me, 'deposits.create');

  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // ----- record deposit dialog state -----
  const [formOpen, setFormOpen] = useState(false);
  const [depositDate, setDepositDate] = useState(todayISO());
  const [bankAccountId, setBankAccountId] = useState('');
  const [memo, setMemo] = useState('');
  const [otherLines, setOtherLines] = useState<OtherLine[]>([]);

  const undeposited = useQuery({
    queryKey: ['undeposited-receipts'],
    queryFn: () => api.get<{ items: UndepositedReceipt[] }>('/api/v1/undeposited-receipts'),
  });
  const deposits = usePagedList<Deposit>(['deposits'], '/api/v1/deposits');
  const accounts = useQuery({
    queryKey: ['accounts', 'for-deposits'],
    queryFn: () => api.get<{ items: Account[] }>('/api/v1/accounts?withBalances=true'),
  });

  const accountItems = accounts.data?.items ?? [];
  const accountById = new Map(accountItems.map((a) => [a.id, a]));
  const bankAccountOptions = accountItems.filter((a) => a.active && a.bankKind === 'bank');
  const otherFundsAccountOptions = accountItems
    .filter((a) => a.active && a.systemKey !== 'accounts_receivable')
    .sort((a, b) => (a.number ?? '').localeCompare(b.number ?? '') || a.name.localeCompare(b.name));

  const receiptItems = undeposited.data?.items ?? [];
  const selectedReceipts = receiptItems.filter((r) => selected[receiptKey(r)]);
  const selectedCents = selectedReceipts.reduce((sum, r) => sum + toCents(r.amount), 0n);

  // ----- form derived values -----
  const completeOtherLines = otherLines.filter(otherLineIsComplete);
  const hasPartialOtherLines = otherLines.some(
    (l) => !otherLineIsBlank(l) && !otherLineIsComplete(l),
  );
  const otherCents = completeOtherLines.reduce((sum, l) => sum + toCents(l.amount), 0n);
  const grandTotalCents = selectedCents + otherCents;
  const canSave =
    depositDate !== '' &&
    bankAccountId !== '' &&
    selectedReceipts.length > 0 &&
    !hasPartialOtherLines;

  function resetForm() {
    setDepositDate(todayISO());
    setBankAccountId('');
    setMemo('');
    setOtherLines([]);
  }

  function updateOtherLine(key: string, patch: Partial<OtherLine>) {
    setOtherLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  const recordDeposit = useMutation({
    mutationFn: () => {
      const payload: {
        depositDate: string;
        bankAccountId: string;
        memo?: string;
        receipts: { sourceType: string; sourceId: string }[];
        otherLines?: { accountId: string; amount: string; description?: string }[];
        idempotencyKey: string;
      } = {
        depositDate,
        bankAccountId,
        receipts: selectedReceipts.map((r) => ({
          sourceType: r.sourceType,
          sourceId: r.sourceId,
        })),
        idempotencyKey: crypto.randomUUID(),
      };
      if (memo.trim() !== '') payload.memo = memo.trim();
      if (completeOtherLines.length > 0) {
        payload.otherLines = completeOtherLines.map((l) => ({
          accountId: l.accountId,
          amount: centsToDecimalString(toCents(l.amount)),
          description: l.description.trim() !== '' ? l.description.trim() : undefined,
        }));
      }
      return api.post<{ id: string; number: string; total: string }>('/api/v1/deposits', payload);
    },
    onSuccess: (data) => {
      toast('success', `Deposit ${data.number} recorded`);
      void qc.invalidateQueries({ queryKey: ['deposits'] });
      void qc.invalidateQueries({ queryKey: ['undeposited-receipts'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      setFormOpen(false);
      setSelected({});
      resetForm();
    },
  });

  if (undeposited.isLoading || deposits.isLoading || accounts.isLoading) {
    return <Spinner label="Loading deposits" />;
  }
  if (undeposited.error) return <ErrorNote error={undeposited.error} />;
  if (deposits.error) return <ErrorNote error={deposits.error} />;
  if (accounts.error) return <ErrorNote error={accounts.error} />;

  const depositItems = deposits.items;

  function bankAccountName(id: string): string {
    const a = accountById.get(id);
    if (!a) return '—';
    return a.number ? `${a.number} · ${a.name}` : a.name;
  }

  return (
    <div>
      <PageHeader
        title="Deposits"
        description="Move money received into Undeposited Funds onto a bank account, matching how it lands on the bank statement."
        actions={
          canCreate ? (
            <Button
              disabled={selectedReceipts.length === 0}
              onClick={() => {
                recordDeposit.reset();
                resetForm();
                setFormOpen(true);
              }}
            >
              Record deposit
            </Button>
          ) : undefined
        }
      />

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Undeposited funds</CardTitle>
        </CardHeader>
        <CardContent>
          {receiptItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing waiting to be deposited. Payments and sales receipts routed to Undeposited
              Funds appear here.
            </p>
          ) : (
            <>
              <Table>
                <THead>
                  <TR>
                    <TH className="w-10">
                      <span className="sr-only">Select</span>
                    </TH>
                    <TH>Number</TH>
                    <TH>Type</TH>
                    <TH>Date</TH>
                    <TH>Party</TH>
                    <TH className="text-right">Amount</TH>
                  </TR>
                </THead>
                <TBody>
                  {receiptItems.map((r) => {
                    const key = receiptKey(r);
                    return (
                      <TR key={key}>
                        <TD>
                          <input
                            type="checkbox"
                            aria-label={`Select ${sourceTypeLabel(r.sourceType)} ${r.number} for deposit`}
                            className="h-4 w-4 rounded border-input"
                            checked={selected[key] ?? false}
                            onChange={(e) =>
                              setSelected((prev) => ({ ...prev, [key]: e.target.checked }))
                            }
                          />
                        </TD>
                        <TD className="font-mono text-[13px] font-medium">{r.number}</TD>
                        <TD className="text-muted-foreground">{sourceTypeLabel(r.sourceType)}</TD>
                        <TD className="text-muted-foreground">{formatDate(r.date)}</TD>
                        <TD>{r.partyName ?? 'Walk-in'}</TD>
                        <TDMoney>{formatMoney(r.amount, currency)}</TDMoney>
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
                      Selected ({selectedReceipts.length})
                    </TD>
                    <TDMoney className="font-semibold">
                      {formatMoney(centsToDecimalString(selectedCents), currency)}
                    </TDMoney>
                  </TR>
                </TFoot>
              </Table>
              {canCreate ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Check the receipts to include, then use “Record deposit”.
                </p>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Deposit history</CardTitle>
        </CardHeader>
        <CardContent>
          {depositItems.length === 0 ? (
            <EmptyState
              title="No deposits yet"
              description="Recorded deposits move funds from Undeposited Funds into a bank account."
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH className="w-10">
                    <span className="sr-only">Expand</span>
                  </TH>
                  <TH>Number</TH>
                  <TH>Date</TH>
                  <TH>Bank account</TH>
                  <TH>Memo</TH>
                  <TH className="text-right">Total</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {depositItems.map((d) => {
                  const isOpen = expanded[d.id] ?? false;
                  return (
                    <DepositRows
                      key={d.id}
                      deposit={d}
                      isOpen={isOpen}
                      onToggle={() =>
                        setExpanded((prev) => ({ ...prev, [d.id]: !(prev[d.id] ?? false) }))
                      }
                      currency={currency}
                      bankAccountName={bankAccountName}
                      accountName={(id) => bankAccountName(id)}
                    />
                  );
                })}
              </TBody>
            </Table>
          )}
          <LoadMoreButton
            hasMore={deposits.hasMore}
            loading={deposits.isLoadingMore}
            onClick={deposits.loadMore}
          />
        </CardContent>
      </Card>

      {/* ----- record deposit dialog ----- */}
      <Dialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) resetForm();
        }}
        title="Record deposit"
        description="Posts a single deposit that debits the bank account and clears the selected receipts from Undeposited Funds."
        wide
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            recordDeposit.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="dep-date">Deposit date</Label>
              <Input
                id="dep-date"
                type="date"
                required
                value={depositDate}
                onChange={(e) => setDepositDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dep-bank">Deposit to bank account</Label>
              <Select
                id="dep-bank"
                required
                value={bankAccountId}
                onChange={(e) => setBankAccountId(e.target.value)}
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
            <div className="space-y-1.5">
              <Label htmlFor="dep-memo">Memo (optional)</Label>
              <Textarea
                id="dep-memo"
                className="min-h-[36px]"
                rows={1}
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
              />
            </div>
          </div>

          <div>
            <p className="mb-1.5 text-sm font-medium">Selected receipts</p>
            {selectedReceipts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No receipts selected. Close this dialog and check at least one undeposited receipt.
              </p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Number</TH>
                    <TH>Type</TH>
                    <TH>Date</TH>
                    <TH>Party</TH>
                    <TH className="text-right">Amount</TH>
                  </TR>
                </THead>
                <TBody>
                  {selectedReceipts.map((r) => (
                    <TR key={receiptKey(r)}>
                      <TD className="font-mono text-[13px]">{r.number}</TD>
                      <TD className="text-muted-foreground">{sourceTypeLabel(r.sourceType)}</TD>
                      <TD className="text-muted-foreground">{formatDate(r.date)}</TD>
                      <TD>{r.partyName ?? 'Walk-in'}</TD>
                      <TDMoney>{formatMoney(r.amount, currency)}</TDMoney>
                    </TR>
                  ))}
                </TBody>
                <TFoot>
                  <TR>
                    <TD
                      colSpan={4}
                      className="text-right text-xs uppercase tracking-wide text-muted-foreground"
                    >
                      Receipts subtotal
                    </TD>
                    <TDMoney>{formatMoney(centsToDecimalString(selectedCents), currency)}</TDMoney>
                  </TR>
                </TFoot>
              </Table>
            )}
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between gap-3">
              <p className="text-sm font-medium">Other funds (optional)</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setOtherLines((prev) => [...prev, emptyOtherLine()])}
              >
                Add other funds line
              </Button>
            </div>
            {otherLines.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Add lines for money in this deposit that is not a customer receipt — for example
                interest income or an owner contribution.
              </p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Account</TH>
                    <TH>Description</TH>
                    <TH className="w-32 text-right">Amount</TH>
                    <TH className="w-12">
                      <span className="sr-only">Remove line</span>
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {otherLines.map((l, idx) => (
                    <TR key={l.key}>
                      <TD>
                        <Select
                          aria-label={`Account for other funds line ${idx + 1}`}
                          value={l.accountId}
                          onChange={(e) => updateOtherLine(l.key, { accountId: e.target.value })}
                        >
                          <option value="">Select account…</option>
                          {otherFundsAccountOptions.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.number ? `${a.number} · ${a.name}` : a.name}
                            </option>
                          ))}
                        </Select>
                      </TD>
                      <TD>
                        <Input
                          aria-label={`Description for other funds line ${idx + 1}`}
                          value={l.description}
                          onChange={(e) => updateOtherLine(l.key, { description: e.target.value })}
                        />
                      </TD>
                      <TD>
                        <MoneyInput
                          aria-label={`Amount for other funds line ${idx + 1}`}
                          placeholder="0.00"
                          value={l.amount}
                          onChange={(e) => {
                            if (PRICE_PATTERN.test(e.target.value)) {
                              updateOtherLine(l.key, { amount: e.target.value });
                            }
                          }}
                        />
                      </TD>
                      <TD>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove other funds line ${idx + 1}`}
                          onClick={() =>
                            setOtherLines((prev) => prev.filter((x) => x.key !== l.key))
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
                      className="text-right text-xs uppercase tracking-wide text-muted-foreground"
                    >
                      Other funds subtotal
                    </TD>
                    <TDMoney>{formatMoney(centsToDecimalString(otherCents), currency)}</TDMoney>
                    <TD />
                  </TR>
                </TFoot>
              </Table>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm font-semibold">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              Deposit total
            </span>
            <span data-money className="font-mono tabular-nums">
              {formatMoney(centsToDecimalString(grandTotalCents), currency)}
            </span>
          </div>

          {recordDeposit.error ? <ApiErrorNote error={recordDeposit.error} /> : null}

          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {selectedReceipts.length === 0
                ? 'At least one undeposited receipt must be selected.'
                : hasPartialOtherLines
                  ? 'Every other-funds line needs an account and an amount greater than zero.'
                  : bankAccountId === ''
                    ? 'Choose the bank account the money was deposited into.'
                    : 'Ready to record.'}
            </p>
            <Button type="submit" disabled={!canSave} loading={recordDeposit.isPending}>
              Record deposit
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

function DepositRows({
  deposit,
  isOpen,
  onToggle,
  currency,
  bankAccountName,
  accountName,
}: {
  deposit: Deposit;
  isOpen: boolean;
  onToggle: () => void;
  currency: string;
  bankAccountName: (id: string) => string;
  accountName: (id: string) => string;
}) {
  return (
    <>
      <TR>
        <TD>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={`${isOpen ? 'Hide' : 'Show'} components of deposit ${deposit.number}`}
            aria-expanded={isOpen}
            onClick={onToggle}
          >
            {isOpen ? (
              <ChevronDown className="h-4 w-4" aria-hidden />
            ) : (
              <ChevronRight className="h-4 w-4" aria-hidden />
            )}
          </Button>
        </TD>
        <TD className="font-mono text-[13px] font-medium">{deposit.number}</TD>
        <TD className="text-muted-foreground">{formatDate(deposit.depositDate)}</TD>
        <TD>{bankAccountName(deposit.bankAccountId)}</TD>
        <TD className="max-w-72 truncate text-muted-foreground">{deposit.memo ?? '—'}</TD>
        <TDMoney>{formatMoney(deposit.total, currency)}</TDMoney>
        <TD>
          <Badge tone={STATUS_TONES[deposit.postingStatus]}>{deposit.postingStatus}</Badge>
        </TD>
      </TR>
      {isOpen ? (
        <TR className="bg-muted/30 hover:bg-muted/30">
          <TD colSpan={7} className="py-3">
            {deposit.components.length === 0 ? (
              <p className="text-sm text-muted-foreground">No components on this deposit.</p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Type</TH>
                    <TH>Description</TH>
                    <TH>Account</TH>
                    <TH className="text-right">Amount</TH>
                  </TR>
                </THead>
                <TBody>
                  {deposit.components.map((c, idx) => (
                    <TR key={`${deposit.id}-${idx}`}>
                      <TD className="text-muted-foreground">{sourceTypeLabel(c.sourceType)}</TD>
                      <TD>{c.description ?? '—'}</TD>
                      <TD className="text-muted-foreground">{accountName(c.accountId)}</TD>
                      <TDMoney>{formatMoney(c.amount, currency)}</TDMoney>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </TD>
        </TR>
      ) : null}
    </>
  );
}
