import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import type { Me } from '@/lib/types';
import { can } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';

type Direction = 'in' | 'out' | 'any';
type MatchType = 'all' | 'any';
type TestField = 'description' | 'reference' | 'amount';
type TestOp = 'contains' | 'equals' | 'starts_with';

interface RuleTest {
  field: TestField;
  op: TestOp;
  value: string;
}

interface BankRule {
  id: string;
  name: string;
  priority: number;
  active: boolean;
  conditions: {
    direction: Direction;
    matchType: MatchType;
    tests: RuleTest[];
  };
  actions: {
    categoryAccountId: string;
    payeeName?: string | null;
    memo?: string | null;
  };
  autoAdd: boolean;
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

const DIRECTION_LABELS: Record<Direction, string> = {
  in: 'Money in',
  out: 'Money out',
  any: 'Any direction',
};

const FIELD_LABELS: Record<TestField, string> = {
  description: 'Description',
  reference: 'Reference',
  amount: 'Amount',
};

const OP_LABELS: Record<TestOp, string> = {
  contains: 'contains',
  equals: 'equals',
  starts_with: 'starts with',
};

const PRIORITY_PATTERN = /^\d+$/;

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

function testsSummary(rule: BankRule): string {
  const joiner = rule.conditions.matchType === 'all' ? ' and ' : ' or ';
  return rule.conditions.tests
    .map((t) => `${FIELD_LABELS[t.field]} ${OP_LABELS[t.op]} “${t.value}”`)
    .join(joiner);
}

interface TestRow {
  key: string;
  field: TestField;
  op: TestOp;
  value: string;
}

function emptyTest(): TestRow {
  return { key: crypto.randomUUID(), field: 'description', op: 'contains', value: '' };
}

export function BankRulesPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const canManage = can(me, 'banking.create');

  // ----- rule form dialog state -----
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [priority, setPriority] = useState('100');
  const [direction, setDirection] = useState<Direction>('any');
  const [matchType, setMatchType] = useState<MatchType>('all');
  const [tests, setTests] = useState<TestRow[]>([emptyTest()]);
  const [categoryAccountId, setCategoryAccountId] = useState('');
  const [payeeName, setPayeeName] = useState('');
  const [memo, setMemo] = useState('');
  const [autoAdd, setAutoAdd] = useState(false);

  const rules = useQuery({
    queryKey: ['banking-rules'],
    queryFn: () => api.get<{ items: BankRule[] }>('/api/v1/banking/rules'),
  });
  const accounts = useQuery({
    queryKey: ['accounts', 'for-bank-rules'],
    queryFn: () => api.get<{ items: ChartAccount[] }>('/api/v1/accounts'),
  });

  const accountItems = accounts.data?.items ?? [];
  const categoryOptions = accountItems.filter((a) => a.active && a.bankKind === null);
  const accountNameById = new Map(accountItems.map((a) => [a.id, a.name]));

  const priorityValid = PRIORITY_PATTERN.test(priority.trim());
  const testsValid = tests.length >= 1 && tests.every((t) => t.value.trim() !== '');
  const canSave = name.trim() !== '' && priorityValid && testsValid && categoryAccountId !== '';

  function resetForm() {
    setEditingId(null);
    setName('');
    setPriority('100');
    setDirection('any');
    setMatchType('all');
    setTests([emptyTest()]);
    setCategoryAccountId('');
    setPayeeName('');
    setMemo('');
    setAutoAdd(false);
  }

  function openNew() {
    saveRule.reset();
    resetForm();
    setFormOpen(true);
  }

  function openEdit(rule: BankRule) {
    saveRule.reset();
    setEditingId(rule.id);
    setName(rule.name);
    setPriority(String(rule.priority));
    setDirection(rule.conditions.direction);
    setMatchType(rule.conditions.matchType);
    setTests(
      rule.conditions.tests.length > 0
        ? rule.conditions.tests.map((t) => ({ key: crypto.randomUUID(), ...t }))
        : [emptyTest()],
    );
    setCategoryAccountId(rule.actions.categoryAccountId);
    setPayeeName(rule.actions.payeeName ?? '');
    setMemo(rule.actions.memo ?? '');
    setAutoAdd(rule.autoAdd);
    setFormOpen(true);
  }

  function updateTest(key: string, patch: Partial<TestRow>) {
    setTests((prev) => prev.map((t) => (t.key === key ? { ...t, ...patch } : t)));
  }

  const saveRule = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        priority: Number(priority.trim()),
        conditions: {
          direction,
          matchType,
          tests: tests.map((t) => ({ field: t.field, op: t.op, value: t.value.trim() })),
        },
        actions: {
          categoryAccountId,
          payeeName: payeeName.trim() !== '' ? payeeName.trim() : undefined,
          memo: memo.trim() !== '' ? memo.trim() : undefined,
        },
        autoAdd,
      };
      return editingId
        ? api.patch<BankRule>(`/api/v1/banking/rules/${editingId}`, body)
        : api.post<BankRule>('/api/v1/banking/rules', body);
    },
    onSuccess: () => {
      toast('success', editingId ? 'Rule updated' : 'Rule created');
      void qc.invalidateQueries({ queryKey: ['banking-rules'] });
      void qc.invalidateQueries({ queryKey: ['banking-items'] });
      setFormOpen(false);
      resetForm();
    },
  });

  const toggleActive = useMutation({
    mutationFn: (rule: BankRule) =>
      api.patch<BankRule>(`/api/v1/banking/rules/${rule.id}`, { active: !rule.active }),
    onSuccess: (_data, rule) => {
      toast(
        'success',
        rule.active ? `Rule "${rule.name}" deactivated` : `Rule "${rule.name}" activated`,
      );
      void qc.invalidateQueries({ queryKey: ['banking-rules'] });
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

  if (rules.isLoading) return <Spinner label="Loading bank rules" />;
  if (rules.error) return <ErrorNote error={rules.error} />;

  const items = [...(rules.data?.items ?? [])].sort((a, b) => a.priority - b.priority);

  return (
    <div>
      <PageHeader
        title="Bank rules"
        description="Rules categorize imported bank transactions automatically. Lower priority numbers run first."
        actions={canManage ? <Button onClick={openNew}>New rule</Button> : undefined}
      />

      {items.length === 0 ? (
        <EmptyState
          title="No bank rules yet"
          description="Create a rule to suggest a category for recurring bank transactions."
          action={canManage ? <Button onClick={openNew}>New rule</Button> : undefined}
        />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH className="w-20">Priority</TH>
              <TH>Name</TH>
              <TH>Direction</TH>
              <TH>Conditions</TH>
              <TH>Category</TH>
              <TH>Behavior</TH>
              <TH>Status</TH>
              {canManage ? <TH className="w-44">Actions</TH> : null}
            </TR>
          </THead>
          <TBody>
            {items.map((rule) => (
              <TR key={rule.id}>
                <TD className="font-mono text-[13px] tabular-nums">{rule.priority}</TD>
                <TD className="font-medium">{rule.name}</TD>
                <TD className="text-muted-foreground">
                  {DIRECTION_LABELS[rule.conditions.direction]}
                </TD>
                <TD className="max-w-xs text-muted-foreground">{testsSummary(rule)}</TD>
                <TD>
                  {accountNameById.get(rule.actions.categoryAccountId) ??
                    rule.actions.categoryAccountId}
                </TD>
                <TD>
                  {rule.autoAdd ? (
                    <Badge
                      tone="warning"
                      title="This rule posts matching transactions to the books without review."
                    >
                      Auto-add
                    </Badge>
                  ) : (
                    <Badge tone="info">Suggested</Badge>
                  )}
                </TD>
                <TD>
                  {rule.active ? (
                    <Badge tone="success">Active</Badge>
                  ) : (
                    <Badge tone="neutral">Inactive</Badge>
                  )}
                </TD>
                {canManage ? (
                  <TD>
                    <div className="flex flex-wrap gap-1">
                      <Button variant="outline" size="sm" onClick={() => openEdit(rule)}>
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={toggleActive.isPending && toggleActive.variables?.id === rule.id}
                        onClick={() => toggleActive.mutate(rule)}
                      >
                        {rule.active ? 'Deactivate' : 'Activate'}
                      </Button>
                    </div>
                  </TD>
                ) : null}
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      {/* ----- new/edit rule dialog ----- */}
      <Dialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) resetForm();
        }}
        title={editingId ? 'Edit rule' : 'New rule'}
        description="When an imported transaction matches every condition, the rule suggests (or auto-adds) the category below."
        wide
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSave) return;
            saveRule.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="rule-name">Name</Label>
              <Input
                id="rule-name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rule-priority">Priority</Label>
              <Input
                id="rule-priority"
                inputMode="numeric"
                required
                value={priority}
                onChange={(e) => {
                  if (e.target.value === '' || PRIORITY_PATTERN.test(e.target.value)) {
                    setPriority(e.target.value);
                  }
                }}
              />
              <p className="text-xs text-muted-foreground">Lower numbers run first.</p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="rule-direction">Direction</Label>
              <Select
                id="rule-direction"
                value={direction}
                onChange={(e) => setDirection(e.target.value as Direction)}
              >
                <option value="any">Any direction</option>
                <option value="in">Money in</option>
                <option value="out">Money out</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rule-match-type">Conditions must match</Label>
              <Select
                id="rule-match-type"
                value={matchType}
                onChange={(e) => setMatchType(e.target.value as MatchType)}
              >
                <option value="all">All conditions</option>
                <option value="any">Any condition</option>
              </Select>
            </div>
          </div>

          <Table>
            <THead>
              <TR>
                <TH className="w-40">Field</TH>
                <TH className="w-36">Operator</TH>
                <TH>Value</TH>
                <TH className="w-12">
                  <span className="sr-only">Remove condition</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {tests.map((t, idx) => (
                <TR key={t.key}>
                  <TD>
                    <Select
                      aria-label={`Field for condition ${idx + 1}`}
                      value={t.field}
                      onChange={(e) => updateTest(t.key, { field: e.target.value as TestField })}
                    >
                      <option value="description">Description</option>
                      <option value="reference">Reference</option>
                      <option value="amount">Amount</option>
                    </Select>
                  </TD>
                  <TD>
                    <Select
                      aria-label={`Operator for condition ${idx + 1}`}
                      value={t.op}
                      onChange={(e) => updateTest(t.key, { op: e.target.value as TestOp })}
                    >
                      <option value="contains">contains</option>
                      <option value="equals">equals</option>
                      <option value="starts_with">starts with</option>
                    </Select>
                  </TD>
                  <TD>
                    <Input
                      aria-label={`Value for condition ${idx + 1}`}
                      required
                      value={t.value}
                      onChange={(e) => updateTest(t.key, { value: e.target.value })}
                    />
                  </TD>
                  <TD>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove condition ${idx + 1}`}
                      disabled={tests.length <= 1}
                      onClick={() =>
                        setTests((prev) =>
                          prev.length > 1 ? prev.filter((x) => x.key !== t.key) : prev,
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
          <Button variant="outline" onClick={() => setTests((prev) => [...prev, emptyTest()])}>
            Add condition
          </Button>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="rule-category">Category account</Label>
              <Select
                id="rule-category"
                required
                value={categoryAccountId}
                onChange={(e) => setCategoryAccountId(e.target.value)}
              >
                <option value="" disabled>
                  Select an account…
                </option>
                {categoryOptions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.number ? `${a.number} · ${a.name}` : a.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rule-payee">Payee (optional)</Label>
              <Input
                id="rule-payee"
                value={payeeName}
                onChange={(e) => setPayeeName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rule-memo">Memo (optional)</Label>
              <Input id="rule-memo" value={memo} onChange={(e) => setMemo(e.target.value)} />
            </div>
          </div>

          <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3">
            <label className="flex items-center gap-2 text-sm font-medium" htmlFor="rule-auto-add">
              <input
                id="rule-auto-add"
                type="checkbox"
                className="h-4 w-4 rounded border-input"
                checked={autoAdd}
                onChange={(e) => setAutoAdd(e.target.checked)}
              />
              Auto-add matching transactions
            </label>
            <p className="text-sm text-muted-foreground">
              Auto-add posts transactions without review. Most companies should leave this off.
            </p>
          </div>

          {saveRule.error ? <ApiErrorNote error={saveRule.error} /> : null}

          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {!canSave
                ? 'A name, a whole-number priority, at least one condition with a value, and a category account are required.'
                : 'Ready to save.'}
            </p>
            <Button type="submit" disabled={!canSave} loading={saveRule.isPending}>
              {editingId ? 'Save changes' : 'Create rule'}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
