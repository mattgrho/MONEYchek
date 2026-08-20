import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
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

interface AccountItem {
  id: string;
  number: string | null;
  name: string;
  category: string;
  detailType: string;
  normalBalance: string;
  systemKey: string | null;
  parentAccountId: string | null;
  postable: boolean;
  active: boolean;
  description: string | null;
  bankKind: string | null;
  balance: string | null;
}

interface JournalApiLine {
  accountId: string;
  debit: string;
  credit: string;
  memo?: string;
}

interface ManualJournal {
  id: string;
  number: string | null;
  journalDate: string;
  memo: string | null;
  lines: JournalApiLine[];
  postingStatus: 'draft' | 'posted' | 'reversed';
  journalEntryId: string | null;
  createdAt: string;
}

/**
 * Exact decimal addition on 2dp strings. Amounts are scaled to integer cents
 * via string manipulation (split on '.', pad the fraction), summed as BigInt,
 * and formatted back. Floats are never involved.
 */
function toCents(value: string): bigint {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d*)?$/.test(trimmed) && !/^-?\.\d+$/.test(trimmed)) return 0n;
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [intPart = '', decPart = ''] = unsigned.split('.');
  const cents =
    BigInt(intPart === '' ? '0' : intPart) * 100n + BigInt((decPart + '00').slice(0, 2));
  return negative ? -cents : cents;
}

function centsToDecimalString(cents: bigint): string {
  const negative = cents < 0n;
  const abs = (negative ? -cents : cents).toString().padStart(3, '0');
  return `${negative ? '-' : ''}${abs.slice(0, -2)}.${abs.slice(-2)}`;
}

function addDecimalStrings(a: string, b: string): string {
  return centsToDecimalString(toCents(a) + toCents(b));
}

/** Grid row state for the journal form. */
interface FormLine {
  key: string;
  accountId: string;
  debit: string;
  credit: string;
  memo: string;
}

function emptyLine(): FormLine {
  return { key: crypto.randomUUID(), accountId: '', debit: '', credit: '', memo: '' };
}

const AMOUNT_PATTERN = /^\d*(\.\d{0,2})?$/;

function statusTone(status: ManualJournal['postingStatus']): 'neutral' | 'success' | 'warning' {
  if (status === 'posted') return 'success';
  if (status === 'reversed') return 'warning';
  return 'neutral';
}

export function JournalsPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const currency = me.company?.homeCurrency ?? 'USD';

  // ----- form dialog state -----
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [journalDate, setJournalDate] = useState(todayISO());
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<FormLine[]>([emptyLine(), emptyLine()]);

  // ----- reverse dialog state -----
  const [reverseTarget, setReverseTarget] = useState<ManualJournal | null>(null);
  const [reverseReason, setReverseReason] = useState('');
  const [reverseDate, setReverseDate] = useState(todayISO());

  const journals = useQuery({
    queryKey: ['manual-journals'],
    queryFn: () => api.get<{ items: ManualJournal[] }>('/api/v1/manual-journals'),
  });
  const accounts = useQuery({
    queryKey: ['accounts', 'for-journals'],
    queryFn: () => api.get<{ items: AccountItem[] }>('/api/v1/accounts'),
  });

  const accountOptions = (accounts.data?.items ?? [])
    .filter((a) => a.active && a.postable)
    .sort((a, b) => (a.number ?? '').localeCompare(b.number ?? '') || a.name.localeCompare(b.name));

  const accountLabel = (id: string): string => {
    const a = accounts.data?.items.find((x) => x.id === id);
    if (!a) return id;
    return a.number ? `${a.number} · ${a.name}` : a.name;
  };

  // ----- form derived values -----
  const totalDebits = lines.reduce((sum, l) => addDecimalStrings(sum, l.debit), '0.00');
  const totalCredits = lines.reduce((sum, l) => addDecimalStrings(sum, l.credit), '0.00');
  const diffCents = toCents(totalDebits) - toCents(totalCredits);
  const difference = centsToDecimalString(diffCents < 0n ? -diffCents : diffCents);

  const lineHasAmount = (l: FormLine) => toCents(l.debit) > 0n || toCents(l.credit) > 0n;
  const lineIsComplete = (l: FormLine) => l.accountId !== '' && lineHasAmount(l);
  const lineIsBlank = (l: FormLine) =>
    l.accountId === '' && !lineHasAmount(l) && l.memo.trim() === '';
  const completeLines = lines.filter(lineIsComplete);
  const hasPartialLines = lines.some((l) => !lineIsBlank(l) && !lineIsComplete(l));
  const balanced = diffCents === 0n && toCents(totalDebits) > 0n;
  const canSave = journalDate !== '' && completeLines.length >= 2 && !hasPartialLines && balanced;

  function resetForm() {
    setEditingId(null);
    setJournalDate(todayISO());
    setMemo('');
    setLines([emptyLine(), emptyLine()]);
  }

  function openCreate() {
    resetForm();
    setFormOpen(true);
  }

  function openEdit(j: ManualJournal) {
    setEditingId(j.id);
    setJournalDate(j.journalDate);
    setMemo(j.memo ?? '');
    setLines(
      j.lines.map((l) => ({
        key: crypto.randomUUID(),
        accountId: l.accountId,
        debit: toCents(l.debit) > 0n ? centsToDecimalString(toCents(l.debit)) : '',
        credit: toCents(l.credit) > 0n ? centsToDecimalString(toCents(l.credit)) : '',
        memo: l.memo ?? '',
      })),
    );
    setFormOpen(true);
  }

  function updateLine(key: string, patch: Partial<FormLine>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function setAmount(key: string, side: 'debit' | 'credit', raw: string) {
    if (!AMOUNT_PATTERN.test(raw)) return;
    if (side === 'debit') {
      updateLine(key, raw === '' ? { debit: raw } : { debit: raw, credit: '' });
    } else {
      updateLine(key, raw === '' ? { credit: raw } : { credit: raw, debit: '' });
    }
  }

  function removeLine(key: string) {
    setLines((prev) => (prev.length > 2 ? prev.filter((l) => l.key !== key) : prev));
  }

  function buildPayload() {
    const payloadLines = completeLines.map((l) => {
      const line: { accountId: string; debit?: string; credit?: string; memo?: string } = {
        accountId: l.accountId,
      };
      if (toCents(l.debit) > 0n) line.debit = centsToDecimalString(toCents(l.debit));
      else line.credit = centsToDecimalString(toCents(l.credit));
      if (l.memo.trim() !== '') line.memo = l.memo.trim();
      return line;
    });
    const payload: {
      journalDate: string;
      memo?: string;
      lines: typeof payloadLines;
    } = { journalDate, lines: payloadLines };
    if (memo.trim() !== '') payload.memo = memo.trim();
    return payload;
  }

  async function saveJournal(): Promise<string> {
    if (editingId) {
      await api.patch<{ ok: boolean }>(`/api/v1/manual-journals/${editingId}`, buildPayload());
      return editingId;
    }
    const created = await api.post<{ id: string }>('/api/v1/manual-journals', buildPayload());
    return created.id;
  }

  const saveDraft = useMutation({
    mutationFn: saveJournal,
    onSuccess: () => {
      toast('success', editingId ? 'Draft updated' : 'Draft saved');
      void qc.invalidateQueries({ queryKey: ['manual-journals'] });
      setFormOpen(false);
      resetForm();
    },
  });

  const saveAndPost = useMutation({
    mutationFn: async () => {
      const id = await saveJournal();
      await api.post<{ journalEntryId: string }>(`/api/v1/manual-journals/${id}/post`, {
        idempotencyKey: crypto.randomUUID(),
      });
    },
    onSuccess: () => {
      toast('success', 'Journal entry posted');
      void qc.invalidateQueries({ queryKey: ['manual-journals'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      setFormOpen(false);
      resetForm();
    },
  });

  const postJournal = useMutation({
    mutationFn: (id: string) =>
      api.post<{ journalEntryId: string }>(`/api/v1/manual-journals/${id}/post`, {
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: () => {
      toast('success', 'Journal entry posted');
      void qc.invalidateQueries({ queryKey: ['manual-journals'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
    },
    onError: (err) => toast('error', err instanceof Error ? err.message : 'Post failed'),
  });

  const reverseJournal = useMutation({
    mutationFn: (input: { id: string; reason: string; postingDate: string }) =>
      api.post<{ reversalEntryId: string }>(`/api/v1/manual-journals/${input.id}/reverse`, {
        idempotencyKey: crypto.randomUUID(),
        reason: input.reason,
        postingDate: input.postingDate,
      }),
    onSuccess: () => {
      toast('success', 'Reversal posted');
      void qc.invalidateQueries({ queryKey: ['manual-journals'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      setReverseTarget(null);
    },
  });

  if (journals.isLoading || accounts.isLoading) return <Spinner label="Loading journal entries" />;

  const items = journals.data?.items ?? [];
  const formBusy = saveDraft.isPending || saveAndPost.isPending;

  return (
    <div>
      <PageHeader
        title="Journal entries"
        description="Manual double-entry journals. Drafts can be edited; posted entries are immutable and can only be reversed."
        actions={
          can(me, 'journals.create') ? (
            <Button onClick={openCreate}>New journal entry</Button>
          ) : undefined
        }
      />

      {items.length === 0 ? (
        <EmptyState
          title="No journal entries yet"
          description="Manual journals record adjustments directly against the chart of accounts."
          action={
            can(me, 'journals.create') ? (
              <Button onClick={openCreate}>New journal entry</Button>
            ) : undefined
          }
        />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Date</TH>
              <TH>Number</TH>
              <TH>Memo</TH>
              <TH className="text-right">Total debits</TH>
              <TH>Status</TH>
              <TH className="w-56">Actions</TH>
            </TR>
          </THead>
          <TBody>
            {items.map((j) => {
              const total = j.lines.reduce((sum, l) => addDecimalStrings(sum, l.debit), '0.00');
              return (
                <TR key={j.id}>
                  <TD>{formatDate(j.journalDate)}</TD>
                  <TD className="font-mono text-[13px]">{j.number ?? 'Draft'}</TD>
                  <TD className="max-w-72 truncate text-muted-foreground">{j.memo ?? '—'}</TD>
                  <TDMoney>{formatMoney(total, currency)}</TDMoney>
                  <TD>
                    <Badge tone={statusTone(j.postingStatus)}>{j.postingStatus}</Badge>
                  </TD>
                  <TD>
                    <div className="flex flex-wrap items-center gap-1">
                      {j.postingStatus === 'draft' ? (
                        <>
                          <Button variant="ghost" size="sm" onClick={() => openEdit(j)}>
                            Edit
                          </Button>
                          {can(me, 'journals.post') ? (
                            <Button
                              variant="outline"
                              size="sm"
                              loading={postJournal.isPending && postJournal.variables === j.id}
                              onClick={() => postJournal.mutate(j.id)}
                            >
                              Post
                            </Button>
                          ) : null}
                        </>
                      ) : null}
                      {j.postingStatus === 'posted' && can(me, 'journals.reverse') ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive"
                          onClick={() => {
                            setReverseTarget(j);
                            setReverseReason('');
                            setReverseDate(todayISO());
                          }}
                        >
                          Reverse
                        </Button>
                      ) : null}
                    </div>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}

      {/* ----- create / edit dialog ----- */}
      <Dialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) resetForm();
        }}
        title={editingId ? 'Edit journal entry' : 'New journal entry'}
        description="Debits must equal credits before the entry can be saved. Each line carries a debit or a credit, never both."
        wide
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            saveDraft.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
            <div className="space-y-1.5">
              <Label htmlFor="journal-date">Journal date</Label>
              <Input
                id="journal-date"
                type="date"
                required
                value={journalDate}
                onChange={(e) => setJournalDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="journal-memo">Memo</Label>
              <Textarea
                id="journal-memo"
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
                <TH>Account</TH>
                <TH className="w-32 text-right">Debit</TH>
                <TH className="w-32 text-right">Credit</TH>
                <TH>Line memo</TH>
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
                      value={l.accountId}
                      onChange={(e) => updateLine(l.key, { accountId: e.target.value })}
                    >
                      <option value="">Select account…</option>
                      {accountOptions.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.number ? `${a.number} · ${a.name}` : a.name}
                        </option>
                      ))}
                    </Select>
                  </TD>
                  <TD>
                    <MoneyInput
                      aria-label={`Debit amount for line ${idx + 1}`}
                      placeholder="0.00"
                      value={l.debit}
                      onChange={(e) => setAmount(l.key, 'debit', e.target.value)}
                    />
                  </TD>
                  <TD>
                    <MoneyInput
                      aria-label={`Credit amount for line ${idx + 1}`}
                      placeholder="0.00"
                      value={l.credit}
                      onChange={(e) => setAmount(l.key, 'credit', e.target.value)}
                    />
                  </TD>
                  <TD>
                    <Input
                      aria-label={`Memo for line ${idx + 1}`}
                      value={l.memo}
                      onChange={(e) => updateLine(l.key, { memo: e.target.value })}
                    />
                  </TD>
                  <TD>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove line ${idx + 1}`}
                      disabled={lines.length <= 2}
                      onClick={() => removeLine(l.key)}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
            <TFoot>
              <TR>
                <TD className="text-right text-xs uppercase tracking-wide text-muted-foreground">
                  Totals
                </TD>
                <TDMoney>{formatMoney(totalDebits, currency)}</TDMoney>
                <TDMoney>{formatMoney(totalCredits, currency)}</TDMoney>
                <TD colSpan={2} className="text-sm">
                  {diffCents === 0n ? (
                    <span className="text-success">Balanced</span>
                  ) : (
                    <span className="text-destructive">
                      Out of balance by{' '}
                      <span data-money className="font-mono tabular-nums">
                        {formatMoney(difference, currency)}
                      </span>
                    </span>
                  )}
                </TD>
              </TR>
            </TFoot>
          </Table>

          <div className="flex items-center justify-between gap-3">
            <Button variant="outline" onClick={() => setLines((prev) => [...prev, emptyLine()])}>
              Add line
            </Button>
            <p className="text-xs text-muted-foreground">
              {completeLines.length < 2
                ? 'At least two complete lines (account + amount) are required.'
                : hasPartialLines
                  ? 'Every non-empty line needs an account and a debit or credit amount.'
                  : !balanced
                    ? 'Total debits must equal total credits.'
                    : 'Ready to save.'}
            </p>
          </div>

          {saveDraft.error ? <ErrorNote error={saveDraft.error} /> : null}
          {saveAndPost.error ? <ErrorNote error={saveAndPost.error} /> : null}

          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="submit"
              variant="secondary"
              disabled={!canSave || formBusy}
              loading={saveDraft.isPending}
            >
              Save draft
            </Button>
            {can(me, 'journals.post') ? (
              <Button
                disabled={!canSave || formBusy}
                loading={saveAndPost.isPending}
                onClick={() => saveAndPost.mutate()}
              >
                Save and post
              </Button>
            ) : null}
          </div>
        </form>
      </Dialog>

      {/* ----- reverse dialog ----- */}
      <Dialog
        open={reverseTarget !== null}
        onOpenChange={(open) => {
          if (!open) setReverseTarget(null);
        }}
        title="Reverse journal entry"
        description={
          reverseTarget
            ? `Posts a mirror-image entry that cancels ${reverseTarget.number ?? 'this journal'} dated ${formatDate(reverseTarget.journalDate)}. The original entry is never altered.`
            : undefined
        }
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!reverseTarget) return;
            reverseJournal.mutate({
              id: reverseTarget.id,
              reason: reverseReason.trim(),
              postingDate: reverseDate,
            });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="reverse-reason">Reason</Label>
            <Textarea
              id="reverse-reason"
              required
              value={reverseReason}
              onChange={(e) => setReverseReason(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reverse-date">Posting date of reversal</Label>
            <Input
              id="reverse-date"
              type="date"
              required
              value={reverseDate}
              onChange={(e) => setReverseDate(e.target.value)}
            />
          </div>
          {reverseJournal.error ? <ErrorNote error={reverseJournal.error} /> : null}
          <Button
            type="submit"
            variant="destructive"
            className="w-full"
            disabled={reverseReason.trim() === '' || reverseDate === ''}
            loading={reverseJournal.isPending}
          >
            Post reversal
          </Button>
        </form>
      </Dialog>
    </div>
  );
}
