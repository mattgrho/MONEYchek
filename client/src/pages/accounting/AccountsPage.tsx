import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Me } from '@/lib/types';
import { can } from '@/lib/types';
import { formatMoney } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Dialog } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import {
  Badge,
  Card,
  CardContent,
  ErrorNote,
  Label,
  PageHeader,
  Select,
  Spinner,
} from '@/components/ui/primitives';
import { Table, TBody, TD, TDMoney, TH, THead, TR } from '@/components/ui/table';

type AccountCategory =
  | 'asset'
  | 'contra_asset'
  | 'liability'
  | 'equity'
  | 'contra_equity'
  | 'income'
  | 'contra_income'
  | 'cogs'
  | 'expense'
  | 'other_income'
  | 'other_expense';

interface Account {
  id: string;
  number: string | null;
  name: string;
  category: AccountCategory;
  detailType: string | null;
  normalBalance: 'debit' | 'credit';
  systemKey: string | null;
  parentAccountId: string | null;
  postable: boolean;
  active: boolean;
  description: string | null;
  bankKind: string | null;
  balance: string | null;
}

const CATEGORY_ORDER: AccountCategory[] = [
  'asset',
  'contra_asset',
  'liability',
  'equity',
  'contra_equity',
  'income',
  'contra_income',
  'cogs',
  'expense',
  'other_income',
  'other_expense',
];

const CATEGORY_LABELS: Record<AccountCategory, { section: string; row: string }> = {
  asset: { section: 'Assets', row: 'Asset' },
  contra_asset: { section: 'Contra assets', row: 'Contra asset' },
  liability: { section: 'Liabilities', row: 'Liability' },
  equity: { section: 'Equity', row: 'Equity' },
  contra_equity: { section: 'Contra equity', row: 'Contra equity' },
  income: { section: 'Income', row: 'Income' },
  contra_income: { section: 'Contra income', row: 'Contra income' },
  cogs: { section: 'Cost of goods sold', row: 'Cost of goods sold' },
  expense: { section: 'Expenses', row: 'Expense' },
  other_income: { section: 'Other income', row: 'Other income' },
  other_expense: { section: 'Other expenses', row: 'Other expense' },
};

const DETAIL_TYPE_DEFAULTS: Record<AccountCategory, { value: string; hint: string }> = {
  asset: {
    value: 'bank',
    hint: 'Common: bank, cash, prepaid_expense, fixed_asset, other. "bank" accounts appear in Banking.',
  },
  contra_asset: {
    value: 'accumulated_depreciation',
    hint: 'Common: accumulated_depreciation, allowance_for_doubtful_accounts, other.',
  },
  liability: {
    value: 'credit_card',
    hint: 'Common: credit_card, loan, accrued_liability, other. "credit_card" accounts appear in Banking.',
  },
  equity: {
    value: 'owner_equity',
    hint: 'Common: owner_equity, retained_earnings, other.',
  },
  contra_equity: {
    value: 'owner_draws',
    hint: 'Common: owner_draws, treasury_stock, other.',
  },
  income: {
    value: 'sales',
    hint: 'Common: sales, service_income, other.',
  },
  contra_income: {
    value: 'discounts',
    hint: 'Common: discounts, returns_and_allowances, other.',
  },
  cogs: {
    value: 'cogs',
    hint: 'Common: cogs, freight, other.',
  },
  expense: {
    value: 'operating_expense',
    hint: 'Common: operating_expense, payroll, rent, other.',
  },
  other_income: {
    value: 'interest_income',
    hint: 'Common: interest_income, gain_on_sale, other.',
  },
  other_expense: {
    value: 'interest_expense',
    hint: 'Common: interest_expense, loss_on_sale, other.',
  },
};

interface NewAccountForm {
  name: string;
  number: string;
  category: AccountCategory;
  detailType: string;
  description: string;
  institutionName: string;
  accountMask: string;
}

interface EditAccountForm {
  name: string;
  number: string;
  description: string;
  active: boolean;
}

const EMPTY_NEW_FORM: NewAccountForm = {
  name: '',
  number: '',
  category: 'asset',
  detailType: DETAIL_TYPE_DEFAULTS.asset.value,
  description: '',
  institutionName: '',
  accountMask: '',
};

export function AccountsPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();
  const currency = me.company?.homeCurrency ?? 'USD';

  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [newForm, setNewForm] = useState<NewAccountForm>(EMPTY_NEW_FORM);

  const [editing, setEditing] = useState<Account | null>(null);
  const [editForm, setEditForm] = useState<EditAccountForm>({
    name: '',
    number: '',
    description: '',
    active: true,
  });
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const accounts = useQuery({
    queryKey: ['accounts', { withBalances: true, includeInactive: showInactive }],
    queryFn: () =>
      api.get<{ items: Account[] }>(
        `/api/v1/accounts?withBalances=true${showInactive ? '&includeInactive=true' : ''}`,
      ),
  });

  const createAccount = useMutation({
    mutationFn: (form: NewAccountForm) => {
      const isBankLike =
        form.detailType.trim() === 'bank' || form.detailType.trim() === 'credit_card';
      return api.post<{ id: string }>('/api/v1/accounts', {
        name: form.name.trim(),
        number: form.number.trim() ? form.number.trim() : undefined,
        category: form.category,
        detailType: form.detailType.trim(),
        description: form.description.trim() ? form.description.trim() : undefined,
        institutionName:
          isBankLike && form.institutionName.trim() ? form.institutionName.trim() : undefined,
        accountMask: isBankLike && form.accountMask.trim() ? form.accountMask.trim() : undefined,
      });
    },
    onSuccess: () => {
      toast('success', 'Account created');
      setCreateOpen(false);
      setNewForm(EMPTY_NEW_FORM);
      void qc.invalidateQueries({ queryKey: ['accounts'] });
    },
  });

  const updateAccount = useMutation({
    mutationFn: (input: { id: string; form: EditAccountForm }) =>
      api.patch<{ ok: boolean }>(`/api/v1/accounts/${input.id}`, {
        name: input.form.name.trim(),
        number: input.form.number.trim() ? input.form.number.trim() : undefined,
        description: input.form.description.trim() ? input.form.description.trim() : undefined,
        active: input.form.active,
      }),
    onSuccess: () => {
      toast('success', 'Account updated');
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ['accounts'] });
    },
  });

  const deleteAccount = useMutation({
    mutationFn: (id: string) => api.delete<{ ok: boolean }>(`/api/v1/accounts/${id}`),
    onSuccess: () => {
      toast('success', 'Account deleted');
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ['accounts'] });
    },
  });

  const grouped = useMemo(() => {
    const items = accounts.data?.items ?? [];
    const q = search.trim().toLowerCase();
    const filtered = q
      ? items.filter(
          (a) => a.name.toLowerCase().includes(q) || (a.number ?? '').toLowerCase().includes(q),
        )
      : items;
    return CATEGORY_ORDER.map((category) => ({
      category,
      items: filtered
        .filter((a) => a.category === category)
        .sort(
          (a, b) => (a.number ?? '').localeCompare(b.number ?? '') || a.name.localeCompare(b.name),
        ),
    })).filter((g) => g.items.length > 0);
  }, [accounts.data, search]);

  const canEdit = can(me, 'accounts.edit');
  const isBankLikeDetail =
    newForm.detailType.trim() === 'bank' || newForm.detailType.trim() === 'credit_card';

  function openEdit(account: Account) {
    setEditing(account);
    setConfirmingDelete(false);
    deleteAccount.reset();
    updateAccount.reset();
    setEditForm({
      name: account.name,
      number: account.number ?? '',
      description: account.description ?? '',
      active: account.active,
    });
  }

  return (
    <div>
      <PageHeader
        title="Chart of accounts"
        description="Every posting in the ledger lands in one of these accounts. Click a row to open its register."
        actions={
          can(me, 'accounts.create') ? (
            <Button
              onClick={() => {
                createAccount.reset();
                setNewForm(EMPTY_NEW_FORM);
                setCreateOpen(true);
              }}
            >
              New account
            </Button>
          ) : undefined
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-4">
        <div className="w-full max-w-xs">
          <Label htmlFor="account-search" className="sr-only">
            Search accounts
          </Label>
          <Input
            id="account-search"
            type="search"
            placeholder="Search by name or number…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm" htmlFor="show-inactive">
          <input
            id="show-inactive"
            type="checkbox"
            className="h-4 w-4 rounded border-input"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          Show inactive
        </label>
      </div>

      {accounts.isLoading ? (
        <Spinner label="Loading accounts" />
      ) : accounts.error ? (
        <ErrorNote error={accounts.error} />
      ) : grouped.length === 0 ? (
        <Card>
          <CardContent className="pt-5">
            <p className="text-sm text-muted-foreground">
              {search.trim() ? 'No accounts match your search.' : 'No accounts yet.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH className="w-24">Number</TH>
              <TH>Name</TH>
              <TH>Type</TH>
              <TH>Detail type</TH>
              <TH className="text-right">Balance</TH>
              <TH>Status</TH>
              {canEdit ? <TH className="w-20">Actions</TH> : null}
            </TR>
          </THead>
          <TBody>
            {grouped.map((group) => (
              <GroupRows
                key={group.category}
                label={CATEGORY_LABELS[group.category].section}
                colSpan={canEdit ? 7 : 6}
              >
                {group.items.map((a) => (
                  <TR
                    key={a.id}
                    className="cursor-pointer"
                    onClick={() => navigate(`/accounting/accounts/${a.id}/register`)}
                  >
                    <TD className="font-mono text-xs text-muted-foreground">{a.number ?? '—'}</TD>
                    <TD>
                      <button
                        type="button"
                        className="text-left font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/accounting/accounts/${a.id}/register`);
                        }}
                      >
                        {a.name}
                      </button>
                    </TD>
                    <TD className="text-muted-foreground">{CATEGORY_LABELS[a.category].row}</TD>
                    <TD className="text-muted-foreground">{a.detailType ?? '—'}</TD>
                    <TDMoney>{formatMoney(a.balance, currency)}</TDMoney>
                    <TD>
                      <span className="flex flex-wrap gap-1">
                        {!a.active ? <Badge tone="warning">Inactive</Badge> : null}
                        {a.systemKey ? <Badge tone="info">Protected</Badge> : null}
                        {a.active && !a.systemKey ? (
                          <span className="text-xs text-muted-foreground">Active</span>
                        ) : null}
                      </span>
                    </TD>
                    {canEdit ? (
                      <TD>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            openEdit(a);
                          }}
                        >
                          Edit
                        </Button>
                      </TD>
                    ) : null}
                  </TR>
                ))}
              </GroupRows>
            ))}
          </TBody>
        </Table>
      )}

      <Dialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New account"
        description="Adds an account to the chart of accounts. Detail types 'bank' and 'credit_card' also appear in Banking."
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            createAccount.mutate(newForm);
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="new-name">Name</Label>
            <Input
              id="new-name"
              required
              value={newForm.name}
              onChange={(e) => setNewForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="new-number">Number (optional)</Label>
              <Input
                id="new-number"
                value={newForm.number}
                onChange={(e) => setNewForm((f) => ({ ...f, number: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-category">Category</Label>
              <Select
                id="new-category"
                required
                value={newForm.category}
                onChange={(e) => {
                  const category = e.target.value as AccountCategory;
                  setNewForm((f) => ({
                    ...f,
                    category,
                    detailType: DETAIL_TYPE_DEFAULTS[category].value,
                  }));
                }}
              >
                {CATEGORY_ORDER.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABELS[c].section}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-detail-type">Detail type</Label>
            <Input
              id="new-detail-type"
              required
              value={newForm.detailType}
              onChange={(e) => setNewForm((f) => ({ ...f, detailType: e.target.value }))}
            />
            <p className="text-xs text-muted-foreground">
              {DETAIL_TYPE_DEFAULTS[newForm.category].hint}
            </p>
          </div>
          {isBankLikeDetail ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="new-institution">Institution name</Label>
                <Input
                  id="new-institution"
                  value={newForm.institutionName}
                  onChange={(e) => setNewForm((f) => ({ ...f, institutionName: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-mask">Account mask</Label>
                <Input
                  id="new-mask"
                  placeholder="e.g. 1234"
                  value={newForm.accountMask}
                  onChange={(e) => setNewForm((f) => ({ ...f, accountMask: e.target.value }))}
                />
              </div>
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="new-description">Description (optional)</Label>
            <Textarea
              id="new-description"
              value={newForm.description}
              onChange={(e) => setNewForm((f) => ({ ...f, description: e.target.value }))}
            />
          </div>
          {createAccount.error ? <ErrorNote error={createAccount.error} /> : null}
          <Button type="submit" loading={createAccount.isPending} className="w-full">
            Create account
          </Button>
        </form>
      </Dialog>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title="Edit account"
        description={
          editing
            ? `${CATEGORY_LABELS[editing.category].row} · ${editing.detailType ?? 'no detail type'}`
            : undefined
        }
      >
        {editing ? (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              updateAccount.mutate({ id: editing.id, form: editForm });
            }}
          >
            {editing.systemKey ? (
              <p className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
                This is a protected system account ({editing.systemKey}); it cannot be edited or
                deleted because the posting engine depends on it.
              </p>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="edit-name">Name</Label>
              <Input
                id="edit-name"
                required
                disabled={editing.systemKey !== null}
                value={editForm.name}
                onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-number">Number (optional)</Label>
              <Input
                id="edit-number"
                disabled={editing.systemKey !== null}
                value={editForm.number}
                onChange={(e) => setEditForm((f) => ({ ...f, number: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-description">Description (optional)</Label>
              <Textarea
                id="edit-description"
                disabled={editing.systemKey !== null}
                value={editForm.description}
                onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
            <label className="flex items-center gap-2 text-sm" htmlFor="edit-active">
              <input
                id="edit-active"
                type="checkbox"
                className="h-4 w-4 rounded border-input"
                disabled={editing.systemKey !== null}
                checked={editForm.active}
                onChange={(e) => setEditForm((f) => ({ ...f, active: e.target.checked }))}
              />
              Active
            </label>
            {updateAccount.error ? <ErrorNote error={updateAccount.error} /> : null}
            {deleteAccount.error ? <ErrorNote error={deleteAccount.error} /> : null}
            <div className="flex items-center justify-between gap-2 pt-1">
              {editing.systemKey === null ? (
                confirmingDelete ? (
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      loading={deleteAccount.isPending}
                      onClick={() => deleteAccount.mutate(editing.id)}
                    >
                      Confirm delete
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirmingDelete(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="text-destructive"
                    onClick={() => setConfirmingDelete(true)}
                  >
                    Delete account
                  </Button>
                )
              ) : (
                <span />
              )}
              <Button
                type="submit"
                loading={updateAccount.isPending}
                disabled={editing.systemKey !== null}
              >
                Save changes
              </Button>
            </div>
          </form>
        ) : null}
      </Dialog>
    </div>
  );
}

function GroupRows({
  label,
  colSpan,
  children,
}: {
  label: string;
  colSpan: number;
  children: React.ReactNode;
}) {
  return (
    <>
      <TR className="bg-muted/60 hover:bg-muted/60">
        <TD
          colSpan={colSpan}
          className="py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          {label}
        </TD>
      </TR>
      {children}
    </>
  );
}
