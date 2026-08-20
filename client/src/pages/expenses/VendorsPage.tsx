import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Me } from '@/lib/types';
import { can } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
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
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';

interface Vendor {
  id: string;
  displayName: string;
  companyName: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  termsDays: number | null;
  is1099Eligible: boolean;
  defaultExpenseAccountId: string | null;
  notes: string | null;
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

interface VendorForm {
  displayName: string;
  companyName: string;
  contactName: string;
  email: string;
  phone: string;
  termsDays: string;
  is1099Eligible: boolean;
  defaultExpenseAccountId: string;
  notes: string;
  active: boolean;
}

const EMPTY_FORM: VendorForm = {
  displayName: '',
  companyName: '',
  contactName: '',
  email: '',
  phone: '',
  termsDays: '',
  is1099Eligible: false,
  defaultExpenseAccountId: '',
  notes: '',
  active: true,
};

const TERMS_PATTERN = /^\d{0,3}$/;
const EXPENSE_ACCOUNT_CATEGORIES = new Set(['expense', 'cogs']);

function toPayload(form: VendorForm, includeActive: boolean) {
  const opt = (v: string): string | null => (v.trim() === '' ? null : v.trim());
  const payload: {
    displayName: string;
    companyName: string | null;
    contactName: string | null;
    email: string | null;
    phone: string | null;
    termsDays: number | null;
    is1099Eligible: boolean;
    defaultExpenseAccountId: string | null;
    notes: string | null;
    active?: boolean;
  } = {
    displayName: form.displayName.trim(),
    companyName: opt(form.companyName),
    contactName: opt(form.contactName),
    email: opt(form.email),
    phone: opt(form.phone),
    termsDays: form.termsDays.trim() === '' ? null : Number.parseInt(form.termsDays.trim(), 10),
    is1099Eligible: form.is1099Eligible,
    defaultExpenseAccountId:
      form.defaultExpenseAccountId === '' ? null : form.defaultExpenseAccountId,
    notes: opt(form.notes),
  };
  if (includeActive) payload.active = form.active;
  return payload;
}

export function VendorsPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Vendor | null>(null);
  const [form, setForm] = useState<VendorForm>(EMPTY_FORM);

  const canCreate = can(me, 'vendors.create');
  const canEdit = can(me, 'vendors.edit');

  const vendors = useQuery({
    queryKey: ['vendors', { includeInactive: showInactive }],
    queryFn: () =>
      api.get<{ items: Vendor[] }>(`/api/v1/vendors${showInactive ? '?includeInactive=true' : ''}`),
  });
  const accounts = useQuery({
    queryKey: ['accounts', 'for-vendors'],
    queryFn: () => api.get<{ items: Account[] }>('/api/v1/accounts'),
    enabled: canCreate || canEdit,
  });

  const expenseAccountOptions = (accounts.data?.items ?? []).filter(
    (a) => a.active && EXPENSE_ACCOUNT_CATEGORIES.has(a.category),
  );

  const createVendor = useMutation({
    mutationFn: (f: VendorForm) => api.post<Vendor>('/api/v1/vendors', toPayload(f, false)),
    onSuccess: (row) => {
      toast('success', `Vendor ${row.displayName} created`);
      setCreateOpen(false);
      setForm(EMPTY_FORM);
      void qc.invalidateQueries({ queryKey: ['vendors'] });
    },
  });

  const updateVendor = useMutation({
    mutationFn: (input: { id: string; form: VendorForm }) =>
      api.patch<Vendor>(`/api/v1/vendors/${input.id}`, toPayload(input.form, true)),
    onSuccess: () => {
      toast('success', 'Vendor updated');
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ['vendors'] });
    },
  });

  const filtered = useMemo(() => {
    const items = vendors.data?.items ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((v) =>
      [v.displayName, v.companyName ?? '', v.contactName ?? '', v.email ?? '', v.phone ?? '']
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [vendors.data, search]);

  function openCreate() {
    createVendor.reset();
    setForm(EMPTY_FORM);
    setCreateOpen(true);
  }

  function openEdit(v: Vendor) {
    if (!canEdit) return;
    updateVendor.reset();
    setForm({
      displayName: v.displayName,
      companyName: v.companyName ?? '',
      contactName: v.contactName ?? '',
      email: v.email ?? '',
      phone: v.phone ?? '',
      termsDays: v.termsDays === null ? '' : String(v.termsDays),
      is1099Eligible: v.is1099Eligible,
      defaultExpenseAccountId: v.defaultExpenseAccountId ?? '',
      notes: v.notes ?? '',
      active: v.active,
    });
    setEditing(v);
  }

  const formFields = (idPrefix: string, isEdit: boolean) => (
    <>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-display-name`}>Display name</Label>
        <Input
          id={`${idPrefix}-display-name`}
          required
          value={form.displayName}
          onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-company`}>Company name</Label>
          <Input
            id={`${idPrefix}-company`}
            value={form.companyName}
            onChange={(e) => setForm((f) => ({ ...f, companyName: e.target.value }))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-contact`}>Contact name</Label>
          <Input
            id={`${idPrefix}-contact`}
            value={form.contactName}
            onChange={(e) => setForm((f) => ({ ...f, contactName: e.target.value }))}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-email`}>Email</Label>
          <Input
            id={`${idPrefix}-email`}
            type="email"
            value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-phone`}>Phone</Label>
          <Input
            id={`${idPrefix}-phone`}
            type="tel"
            value={form.phone}
            onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-terms`}>Payment terms (days)</Label>
          <Input
            id={`${idPrefix}-terms`}
            inputMode="numeric"
            placeholder="e.g. 30"
            value={form.termsDays}
            onChange={(e) => {
              const raw = e.target.value;
              if (TERMS_PATTERN.test(raw)) setForm((f) => ({ ...f, termsDays: raw }));
            }}
          />
          <p className="text-xs text-muted-foreground">
            Default number of days until bills from this vendor are due.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-default-account`}>Default expense account</Label>
          <Select
            id={`${idPrefix}-default-account`}
            value={form.defaultExpenseAccountId}
            onChange={(e) => setForm((f) => ({ ...f, defaultExpenseAccountId: e.target.value }))}
          >
            <option value="">No default</option>
            {expenseAccountOptions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.number ? `${a.number} · ${a.name}` : a.name}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div className="space-y-1.5">
        <label className="flex items-center gap-2 text-sm" htmlFor={`${idPrefix}-1099`}>
          <input
            id={`${idPrefix}-1099`}
            type="checkbox"
            className="h-4 w-4 rounded border-input"
            checked={form.is1099Eligible}
            onChange={(e) => setForm((f) => ({ ...f, is1099Eligible: e.target.checked }))}
          />
          1099 eligible
        </label>
        <p className="text-xs text-muted-foreground">
          Tracked for the 1099 review report; nothing is filed automatically.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-notes`}>Notes</Label>
        <Textarea
          id={`${idPrefix}-notes`}
          value={form.notes}
          onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
        />
      </div>
      {isEdit ? (
        <label className="flex items-center gap-2 text-sm" htmlFor={`${idPrefix}-active`}>
          <input
            id={`${idPrefix}-active`}
            type="checkbox"
            className="h-4 w-4 rounded border-input"
            checked={form.active}
            onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))}
          />
          Active
        </label>
      ) : null}
    </>
  );

  return (
    <div>
      <PageHeader
        title="Vendors"
        description="Everyone you buy from. Terms and the default expense account flow onto new bills and expenses for the vendor."
        actions={canCreate ? <Button onClick={openCreate}>New vendor</Button> : undefined}
      />

      <div className="mb-4 flex flex-wrap items-center gap-4">
        <div className="w-full max-w-xs">
          <Label htmlFor="vendor-search" className="sr-only">
            Search vendors
          </Label>
          <Input
            id="vendor-search"
            type="search"
            placeholder="Search by name, company, email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm" htmlFor="vendors-show-inactive">
          <input
            id="vendors-show-inactive"
            type="checkbox"
            className="h-4 w-4 rounded border-input"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          Show inactive
        </label>
      </div>

      {vendors.isLoading ? (
        <Spinner label="Loading vendors" />
      ) : vendors.error ? (
        <ErrorNote error={vendors.error} />
      ) : (vendors.data?.items.length ?? 0) === 0 ? (
        <EmptyState
          title="No vendors yet"
          description="Add your first vendor to start entering bills and expenses."
          action={canCreate ? <Button onClick={openCreate}>New vendor</Button> : undefined}
        />
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="pt-5">
            <p className="text-sm text-muted-foreground">No vendors match your search.</p>
          </CardContent>
        </Card>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Name</TH>
              <TH>Company</TH>
              <TH>Email</TH>
              <TH>Phone</TH>
              <TH>Terms</TH>
              <TH>Status</TH>
              {canEdit ? <TH className="w-20">Actions</TH> : null}
            </TR>
          </THead>
          <TBody>
            {filtered.map((v) => (
              <TR
                key={v.id}
                className={canEdit ? 'cursor-pointer' : undefined}
                onClick={() => openEdit(v)}
              >
                <TD>
                  <div className="font-medium">{v.displayName}</div>
                  {v.contactName ? (
                    <div className="text-xs text-muted-foreground">{v.contactName}</div>
                  ) : null}
                </TD>
                <TD className="text-muted-foreground">{v.companyName ?? '—'}</TD>
                <TD className="text-muted-foreground">{v.email ?? '—'}</TD>
                <TD className="text-muted-foreground">{v.phone ?? '—'}</TD>
                <TD className="text-muted-foreground">
                  {v.termsDays === null ? '—' : `Net ${v.termsDays}`}
                </TD>
                <TD>
                  <span className="flex flex-wrap gap-1">
                    {v.active ? (
                      <Badge tone="success">Active</Badge>
                    ) : (
                      <Badge tone="warning">Inactive</Badge>
                    )}
                    {v.is1099Eligible ? <Badge tone="info">1099</Badge> : null}
                  </span>
                </TD>
                {canEdit ? (
                  <TD>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        openEdit(v);
                      }}
                    >
                      Edit
                    </Button>
                  </TD>
                ) : null}
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      <Dialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New vendor"
        description="Only the display name is required; everything else can be filled in later."
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            createVendor.mutate(form);
          }}
        >
          {formFields('new-vendor', false)}
          {createVendor.error ? <ErrorNote error={createVendor.error} /> : null}
          <Button type="submit" loading={createVendor.isPending} className="w-full">
            Create vendor
          </Button>
        </form>
      </Dialog>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title="Edit vendor"
        description={editing ? editing.displayName : undefined}
      >
        {editing ? (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              updateVendor.mutate({ id: editing.id, form });
            }}
          >
            {formFields('edit-vendor', true)}
            {updateVendor.error ? <ErrorNote error={updateVendor.error} /> : null}
            <Button type="submit" loading={updateVendor.isPending} className="w-full">
              Save changes
            </Button>
          </form>
        ) : null}
      </Dialog>
    </div>
  );
}
