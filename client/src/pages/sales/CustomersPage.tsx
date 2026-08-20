import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
  Spinner,
} from '@/components/ui/primitives';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';

interface Customer {
  id: string;
  displayName: string;
  companyName: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  termsDays: number | null;
  taxExempt: boolean;
  notes: string | null;
  active: boolean;
}

interface CustomerForm {
  displayName: string;
  companyName: string;
  contactName: string;
  email: string;
  phone: string;
  termsDays: string;
  taxExempt: boolean;
  notes: string;
  active: boolean;
}

const EMPTY_FORM: CustomerForm = {
  displayName: '',
  companyName: '',
  contactName: '',
  email: '',
  phone: '',
  termsDays: '',
  taxExempt: false,
  notes: '',
  active: true,
};

const TERMS_PATTERN = /^\d{0,3}$/;

function toPayload(form: CustomerForm, includeActive: boolean) {
  const opt = (v: string): string | null => (v.trim() === '' ? null : v.trim());
  const payload: {
    displayName: string;
    companyName: string | null;
    contactName: string | null;
    email: string | null;
    phone: string | null;
    termsDays: number | null;
    taxExempt: boolean;
    notes: string | null;
    active?: boolean;
  } = {
    displayName: form.displayName.trim(),
    companyName: opt(form.companyName),
    contactName: opt(form.contactName),
    email: opt(form.email),
    phone: opt(form.phone),
    termsDays: form.termsDays.trim() === '' ? null : Number.parseInt(form.termsDays.trim(), 10),
    taxExempt: form.taxExempt,
    notes: opt(form.notes),
  };
  if (includeActive) payload.active = form.active;
  return payload;
}

export function CustomersPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [form, setForm] = useState<CustomerForm>(EMPTY_FORM);

  const canCreate = can(me, 'customers.create');
  const canEdit = can(me, 'customers.edit');

  const customers = useQuery({
    queryKey: ['customers', { includeInactive: showInactive }],
    queryFn: () =>
      api.get<{ items: Customer[] }>(
        `/api/v1/customers${showInactive ? '?includeInactive=true' : ''}`,
      ),
  });

  const createCustomer = useMutation({
    mutationFn: (f: CustomerForm) => api.post<Customer>('/api/v1/customers', toPayload(f, false)),
    onSuccess: () => {
      toast('success', 'Customer created');
      setCreateOpen(false);
      setForm(EMPTY_FORM);
      void qc.invalidateQueries({ queryKey: ['customers'] });
    },
  });

  const updateCustomer = useMutation({
    mutationFn: (input: { id: string; form: CustomerForm }) =>
      api.patch<Customer>(`/api/v1/customers/${input.id}`, toPayload(input.form, true)),
    onSuccess: () => {
      toast('success', 'Customer updated');
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ['customers'] });
    },
  });

  const filtered = useMemo(() => {
    const items = customers.data?.items ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((c) =>
      [c.displayName, c.companyName ?? '', c.contactName ?? '', c.email ?? '', c.phone ?? '']
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [customers.data, search]);

  function openCreate() {
    createCustomer.reset();
    setForm(EMPTY_FORM);
    setCreateOpen(true);
  }

  function openEdit(c: Customer) {
    if (!canEdit) return;
    updateCustomer.reset();
    setForm({
      displayName: c.displayName,
      companyName: c.companyName ?? '',
      contactName: c.contactName ?? '',
      email: c.email ?? '',
      phone: c.phone ?? '',
      termsDays: c.termsDays === null ? '' : String(c.termsDays),
      taxExempt: c.taxExempt,
      notes: c.notes ?? '',
      active: c.active,
    });
    setEditing(c);
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
          Default number of days until invoices for this customer are due.
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
      <label className="flex items-center gap-2 text-sm" htmlFor={`${idPrefix}-tax-exempt`}>
        <input
          id={`${idPrefix}-tax-exempt`}
          type="checkbox"
          className="h-4 w-4 rounded border-input"
          checked={form.taxExempt}
          onChange={(e) => setForm((f) => ({ ...f, taxExempt: e.target.checked }))}
        />
        Tax exempt
      </label>
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
        title="Customers"
        description="Everyone you sell to. Terms and tax-exempt status flow onto new invoices for the customer."
        actions={canCreate ? <Button onClick={openCreate}>New customer</Button> : undefined}
      />

      <div className="mb-4 flex flex-wrap items-center gap-4">
        <div className="w-full max-w-xs">
          <Label htmlFor="customer-search" className="sr-only">
            Search customers
          </Label>
          <Input
            id="customer-search"
            type="search"
            placeholder="Search by name, company, email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm" htmlFor="customers-show-inactive">
          <input
            id="customers-show-inactive"
            type="checkbox"
            className="h-4 w-4 rounded border-input"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          Show inactive
        </label>
      </div>

      {customers.isLoading ? (
        <Spinner label="Loading customers" />
      ) : customers.error ? (
        <ErrorNote error={customers.error} />
      ) : (customers.data?.items.length ?? 0) === 0 ? (
        <EmptyState
          title="No customers yet"
          description="Add your first customer to start sending estimates and invoices."
          action={canCreate ? <Button onClick={openCreate}>New customer</Button> : undefined}
        />
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="pt-5">
            <p className="text-sm text-muted-foreground">No customers match your search.</p>
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
              <TH className="w-36">Actions</TH>
            </TR>
          </THead>
          <TBody>
            {filtered.map((c) => (
              <TR
                key={c.id}
                className={canEdit ? 'cursor-pointer' : undefined}
                onClick={() => openEdit(c)}
              >
                <TD>
                  <div className="font-medium">{c.displayName}</div>
                  {c.contactName ? (
                    <div className="text-xs text-muted-foreground">{c.contactName}</div>
                  ) : null}
                </TD>
                <TD className="text-muted-foreground">{c.companyName ?? '—'}</TD>
                <TD className="text-muted-foreground">{c.email ?? '—'}</TD>
                <TD className="text-muted-foreground">{c.phone ?? '—'}</TD>
                <TD className="text-muted-foreground">
                  {c.termsDays === null ? '—' : `Net ${c.termsDays}`}
                </TD>
                <TD>
                  <span className="flex flex-wrap gap-1">
                    {c.active ? (
                      <Badge tone="success">Active</Badge>
                    ) : (
                      <Badge tone="warning">Inactive</Badge>
                    )}
                    {c.taxExempt ? <Badge tone="info">Tax exempt</Badge> : null}
                  </span>
                </TD>
                <TD>
                  <div className="flex flex-wrap items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/sales/invoices?customerId=${c.id}`);
                      }}
                    >
                      Invoices
                    </Button>
                    {canEdit ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          openEdit(c);
                        }}
                      >
                        Edit
                      </Button>
                    ) : null}
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      <Dialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New customer"
        description="Only the display name is required; everything else can be filled in later."
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            createCustomer.mutate(form);
          }}
        >
          {formFields('new-customer', false)}
          {createCustomer.error ? <ErrorNote error={createCustomer.error} /> : null}
          <Button type="submit" loading={createCustomer.isPending} className="w-full">
            Create customer
          </Button>
        </form>
      </Dialog>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title="Edit customer"
        description={editing ? editing.displayName : undefined}
      >
        {editing ? (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              updateCustomer.mutate({ id: editing.id, form });
            }}
          >
            {formFields('edit-customer', true)}
            {updateCustomer.error ? <ErrorNote error={updateCustomer.error} /> : null}
            <Button type="submit" loading={updateCustomer.isPending} className="w-full">
              Save changes
            </Button>
          </form>
        ) : null}
      </Dialog>
    </div>
  );
}
