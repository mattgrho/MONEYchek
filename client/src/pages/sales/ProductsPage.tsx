import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Me } from '@/lib/types';
import { can } from '@/lib/types';
import { formatMoney } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input, MoneyInput, Textarea } from '@/components/ui/input';
import { Dialog } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorNote,
  Label,
  PageHeader,
  Select,
  Spinner,
} from '@/components/ui/primitives';
import { Table, TBody, TD, TDMoney, TH, THead, TR } from '@/components/ui/table';

type ProductType = 'service' | 'non_inventory' | 'inventory';

interface Product {
  id: string;
  type: ProductType;
  name: string;
  sku: string | null;
  salesDescription: string | null;
  salesPrice: string | null;
  purchaseCost: string | null;
  incomeAccountId: string | null;
  expenseAccountId: string | null;
  taxable: boolean;
  active: boolean;
}

interface AccountItem {
  id: string;
  number: string | null;
  name: string;
  category: string;
  detailType: string | null;
  systemKey: string | null;
  bankKind: string | null;
  active: boolean;
}

interface TaxRate {
  id: string;
  name: string;
  agencyName: string | null;
  rate: string;
  active: boolean;
}

const TYPE_LABELS: Record<ProductType, string> = {
  service: 'Service',
  non_inventory: 'Non-inventory',
  inventory: 'Inventory',
};

const INCOME_CATEGORIES = new Set(['income', 'other_income']);
const EXPENSE_CATEGORIES = new Set(['expense', 'cogs', 'other_expense']);

/** Input pattern for money fields: digits with up to two decimals. */
const PRICE_PATTERN = /^\d*(\.\d{0,2})?$/;
/** Input pattern for a tax percentage: up to two integer digits, up to four decimals. */
const PERCENT_PATTERN = /^\d{0,2}(\.\d{0,4})?$/;

/** Normalizes a price input to a canonical decimal string, or null when empty/invalid. */
function priceToPayload(raw: string): string | null {
  const trimmed = raw.trim().replace(/\.$/, '');
  if (trimmed === '') return null;
  const normalized = trimmed.startsWith('.') ? `0${trimmed}` : trimmed;
  return /^\d+(\.\d+)?$/.test(normalized) ? normalized : null;
}

/**
 * Converts a fraction string (e.g. "0.0825") to a percent string ("8.25")
 * purely with string operations — the decimal point moves two places right.
 */
function fractionToPercent(fraction: string): string {
  if (!/^\d+(\.\d+)?$/.test(fraction)) return fraction;
  const [intPart = '0', decPart = ''] = fraction.split('.');
  const dec = decPart + '00';
  const shiftedInt = (intPart + dec.slice(0, 2)).replace(/^0+(?=\d)/, '');
  const shiftedDec = dec.slice(2).replace(/0+$/, '');
  return shiftedDec ? `${shiftedInt}.${shiftedDec}` : shiftedInt;
}

interface ProductForm {
  type: ProductType;
  name: string;
  sku: string;
  salesDescription: string;
  salesPrice: string;
  purchaseCost: string;
  incomeAccountId: string;
  expenseAccountId: string;
  taxable: boolean;
  active: boolean;
}

const EMPTY_FORM: ProductForm = {
  type: 'service',
  name: '',
  sku: '',
  salesDescription: '',
  salesPrice: '',
  purchaseCost: '',
  incomeAccountId: '',
  expenseAccountId: '',
  taxable: true,
  active: true,
};

function toPayload(form: ProductForm, mode: 'create' | 'edit') {
  const opt = (v: string): string | null => (v.trim() === '' ? null : v.trim());
  const payload: {
    type?: ProductType;
    name: string;
    sku: string | null;
    salesDescription: string | null;
    salesPrice: string | null;
    purchaseCost: string | null;
    incomeAccountId: string | null;
    expenseAccountId: string | null;
    taxable: boolean;
    active?: boolean;
  } = {
    name: form.name.trim(),
    sku: opt(form.sku),
    salesDescription: opt(form.salesDescription),
    salesPrice: priceToPayload(form.salesPrice),
    purchaseCost: priceToPayload(form.purchaseCost),
    incomeAccountId: form.incomeAccountId === '' ? null : form.incomeAccountId,
    expenseAccountId: form.expenseAccountId === '' ? null : form.expenseAccountId,
    taxable: form.taxable,
  };
  if (mode === 'create') payload.type = form.type;
  else payload.active = form.active;
  return payload;
}

export function ProductsPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const currency = me.company?.homeCurrency ?? 'USD';

  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [form, setForm] = useState<ProductForm>(EMPTY_FORM);

  const [taxName, setTaxName] = useState('');
  const [taxAgency, setTaxAgency] = useState('');
  const [taxPercent, setTaxPercent] = useState('');

  const canCreate = can(me, 'products.create');
  const canEdit = can(me, 'products.edit');
  const canSeeTaxRates = can(me, 'invoices.view');
  const canAddTaxRate = can(me, 'invoices.create');

  const products = useQuery({
    queryKey: ['products', { includeInactive: showInactive }],
    queryFn: () =>
      api.get<{ items: Product[] }>(
        `/api/v1/products${showInactive ? '?includeInactive=true' : ''}`,
      ),
  });

  const accounts = useQuery({
    queryKey: ['accounts', 'for-products'],
    queryFn: () => api.get<{ items: AccountItem[] }>('/api/v1/accounts'),
  });

  const taxRates = useQuery({
    queryKey: ['tax-rates'],
    queryFn: () => api.get<{ items: TaxRate[] }>('/api/v1/tax-rates'),
    enabled: canSeeTaxRates,
  });

  const createProduct = useMutation({
    mutationFn: (f: ProductForm) => api.post<Product>('/api/v1/products', toPayload(f, 'create')),
    onSuccess: () => {
      toast('success', 'Product created');
      setCreateOpen(false);
      setForm(EMPTY_FORM);
      void qc.invalidateQueries({ queryKey: ['products'] });
    },
  });

  const updateProduct = useMutation({
    mutationFn: (input: { id: string; form: ProductForm }) =>
      api.patch<Product>(`/api/v1/products/${input.id}`, toPayload(input.form, 'edit')),
    onSuccess: () => {
      toast('success', 'Product updated');
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ['products'] });
    },
  });

  const createTaxRate = useMutation({
    mutationFn: () =>
      api.post<TaxRate>('/api/v1/tax-rates', {
        name: taxName.trim(),
        agencyName: taxAgency.trim() === '' ? undefined : taxAgency.trim(),
        ratePercent: taxPercent.trim().replace(/\.$/, ''),
      }),
    onSuccess: () => {
      toast('success', 'Tax rate added');
      setTaxName('');
      setTaxAgency('');
      setTaxPercent('');
      void qc.invalidateQueries({ queryKey: ['tax-rates'] });
    },
  });

  const accountItems = accounts.data?.items ?? [];
  const incomeAccounts = accountItems
    .filter((a) => a.active && INCOME_CATEGORIES.has(a.category))
    .sort((a, b) => (a.number ?? '').localeCompare(b.number ?? '') || a.name.localeCompare(b.name));
  const expenseAccounts = accountItems
    .filter((a) => a.active && EXPENSE_CATEGORIES.has(a.category))
    .sort((a, b) => (a.number ?? '').localeCompare(b.number ?? '') || a.name.localeCompare(b.name));

  const filtered = useMemo(() => {
    const items = products.data?.items ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((p) =>
      [p.name, p.sku ?? '', p.salesDescription ?? ''].join(' ').toLowerCase().includes(q),
    );
  }, [products.data, search]);

  function openCreate() {
    createProduct.reset();
    setForm(EMPTY_FORM);
    setCreateOpen(true);
  }

  function openEdit(p: Product) {
    if (!canEdit) return;
    updateProduct.reset();
    setForm({
      type: p.type,
      name: p.name,
      sku: p.sku ?? '',
      salesDescription: p.salesDescription ?? '',
      salesPrice: p.salesPrice ?? '',
      purchaseCost: p.purchaseCost ?? '',
      incomeAccountId: p.incomeAccountId ?? '',
      expenseAccountId: p.expenseAccountId ?? '',
      taxable: p.taxable,
      active: p.active,
    });
    setEditing(p);
  }

  const accountOption = (a: AccountItem) => (
    <option key={a.id} value={a.id}>
      {a.number ? `${a.number} · ${a.name}` : a.name}
    </option>
  );

  const formFields = (idPrefix: string, mode: 'create' | 'edit') => (
    <>
      {mode === 'create' ? (
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-type`}>Type</Label>
          <Select
            id={`${idPrefix}-type`}
            required
            value={form.type}
            onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as ProductType }))}
          >
            <option value="service">Service</option>
            <option value="non_inventory">Non-inventory</option>
            <option value="inventory">Inventory (tracked quantity, FIFO cost)</option>
          </Select>
          <p className="text-xs text-muted-foreground">
            {form.type === 'inventory'
              ? 'Stock arrives through posted bills (or adjustments) and is relieved at FIFO cost when invoices post. See Accounting → Inventory for on-hand values.'
              : 'Services and non-inventory items do not track quantity on hand.'}
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Type: {TYPE_LABELS[form.type]} (cannot be changed after creation)
        </p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-name`}>Name</Label>
          <Input
            id={`${idPrefix}-name`}
            required
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-sku`}>SKU</Label>
          <Input
            id={`${idPrefix}-sku`}
            value={form.sku}
            onChange={(e) => setForm((f) => ({ ...f, sku: e.target.value }))}
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-sales-description`}>Sales description</Label>
        <Textarea
          id={`${idPrefix}-sales-description`}
          value={form.salesDescription}
          onChange={(e) => setForm((f) => ({ ...f, salesDescription: e.target.value }))}
        />
        <p className="text-xs text-muted-foreground">
          Prefills the line description on estimates and invoices.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-sales-price`}>Sales price</Label>
          <MoneyInput
            id={`${idPrefix}-sales-price`}
            placeholder="0.00"
            value={form.salesPrice}
            onChange={(e) => {
              const raw = e.target.value;
              if (PRICE_PATTERN.test(raw)) setForm((f) => ({ ...f, salesPrice: raw }));
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-purchase-cost`}>Purchase cost</Label>
          <MoneyInput
            id={`${idPrefix}-purchase-cost`}
            placeholder="0.00"
            value={form.purchaseCost}
            onChange={(e) => {
              const raw = e.target.value;
              if (PRICE_PATTERN.test(raw)) setForm((f) => ({ ...f, purchaseCost: raw }));
            }}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-income-account`}>Income account</Label>
          <Select
            id={`${idPrefix}-income-account`}
            value={form.incomeAccountId}
            onChange={(e) => setForm((f) => ({ ...f, incomeAccountId: e.target.value }))}
          >
            <option value="">None</option>
            {incomeAccounts.map(accountOption)}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-expense-account`}>Expense account</Label>
          <Select
            id={`${idPrefix}-expense-account`}
            value={form.expenseAccountId}
            onChange={(e) => setForm((f) => ({ ...f, expenseAccountId: e.target.value }))}
          >
            <option value="">None</option>
            {expenseAccounts.map(accountOption)}
          </Select>
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm" htmlFor={`${idPrefix}-taxable`}>
        <input
          id={`${idPrefix}-taxable`}
          type="checkbox"
          className="h-4 w-4 rounded border-input"
          checked={form.taxable}
          onChange={(e) => setForm((f) => ({ ...f, taxable: e.target.checked }))}
        />
        Taxable
      </label>
      {mode === 'edit' ? (
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

  const taxRateItems = taxRates.data?.items ?? [];
  const taxFormValid =
    taxName.trim() !== '' && /^\d{1,2}(\.\d{1,4})?$/.test(taxPercent.trim().replace(/\.$/, ''));

  return (
    <div>
      <PageHeader
        title="Products & services"
        description="The catalog used on estimates, invoices, and sales receipts. Prices are defaults and can be overridden per line."
        actions={canCreate ? <Button onClick={openCreate}>New product</Button> : undefined}
      />

      <div className="mb-4 flex flex-wrap items-center gap-4">
        <div className="w-full max-w-xs">
          <Label htmlFor="product-search" className="sr-only">
            Search products
          </Label>
          <Input
            id="product-search"
            type="search"
            placeholder="Search by name, SKU…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm" htmlFor="products-show-inactive">
          <input
            id="products-show-inactive"
            type="checkbox"
            className="h-4 w-4 rounded border-input"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          Show inactive
        </label>
      </div>

      {products.isLoading || accounts.isLoading ? (
        <Spinner label="Loading products" />
      ) : products.error ? (
        <ErrorNote error={products.error} />
      ) : (products.data?.items.length ?? 0) === 0 ? (
        <EmptyState
          title="No products or services yet"
          description="Add a catalog item so sales forms can prefill descriptions, prices, and accounts."
          action={canCreate ? <Button onClick={openCreate}>New product</Button> : undefined}
        />
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="pt-5">
            <p className="text-sm text-muted-foreground">No products match your search.</p>
          </CardContent>
        </Card>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Name</TH>
              <TH>Type</TH>
              <TH>SKU</TH>
              <TH className="text-right">Sales price</TH>
              <TH>Tax</TH>
              <TH>Status</TH>
              {canEdit ? <TH className="w-20">Actions</TH> : null}
            </TR>
          </THead>
          <TBody>
            {filtered.map((p) => (
              <TR
                key={p.id}
                className={canEdit ? 'cursor-pointer' : undefined}
                onClick={() => openEdit(p)}
              >
                <TD>
                  <div className="font-medium">{p.name}</div>
                  {p.salesDescription ? (
                    <div className="max-w-72 truncate text-xs text-muted-foreground">
                      {p.salesDescription}
                    </div>
                  ) : null}
                </TD>
                <TD className="text-muted-foreground">{TYPE_LABELS[p.type]}</TD>
                <TD className="font-mono text-xs text-muted-foreground">{p.sku ?? '—'}</TD>
                <TDMoney>{formatMoney(p.salesPrice, currency)}</TDMoney>
                <TD>
                  {p.taxable ? (
                    <Badge tone="info">Taxable</Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">Non-taxable</span>
                  )}
                </TD>
                <TD>
                  {p.active ? (
                    <Badge tone="success">Active</Badge>
                  ) : (
                    <Badge tone="warning">Inactive</Badge>
                  )}
                </TD>
                {canEdit ? (
                  <TD>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        openEdit(p);
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

      {canSeeTaxRates ? (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Tax rates</CardTitle>
            <CardDescription>
              Sales tax rates available on estimates, invoices, and sales receipts.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {taxRates.isLoading ? (
              <Spinner label="Loading tax rates" />
            ) : taxRates.error ? (
              <ErrorNote error={taxRates.error} />
            ) : taxRateItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tax rates yet.</p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Name</TH>
                    <TH>Agency</TH>
                    <TH className="text-right">Rate</TH>
                    <TH>Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {taxRateItems.map((t) => (
                    <TR key={t.id}>
                      <TD className="font-medium">{t.name}</TD>
                      <TD className="text-muted-foreground">{t.agencyName ?? '—'}</TD>
                      <TD className="text-right font-mono text-[13px] tabular-nums">
                        {fractionToPercent(t.rate)}%
                      </TD>
                      <TD>
                        {t.active ? (
                          <span className="text-xs text-muted-foreground">Active</span>
                        ) : (
                          <Badge tone="warning">Inactive</Badge>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}

            {canAddTaxRate ? (
              <form
                className="flex flex-wrap items-end gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  createTaxRate.mutate();
                }}
              >
                <div className="w-full max-w-48 space-y-1.5">
                  <Label htmlFor="tax-rate-name">Name</Label>
                  <Input
                    id="tax-rate-name"
                    required
                    placeholder="e.g. State sales tax"
                    value={taxName}
                    onChange={(e) => setTaxName(e.target.value)}
                  />
                </div>
                <div className="w-full max-w-48 space-y-1.5">
                  <Label htmlFor="tax-rate-agency">Agency</Label>
                  <Input
                    id="tax-rate-agency"
                    placeholder="Optional"
                    value={taxAgency}
                    onChange={(e) => setTaxAgency(e.target.value)}
                  />
                </div>
                <div className="w-full max-w-32 space-y-1.5">
                  <Label htmlFor="tax-rate-percent">Rate (%)</Label>
                  <Input
                    id="tax-rate-percent"
                    required
                    inputMode="decimal"
                    placeholder="8.25"
                    className="text-right font-mono tabular-nums"
                    value={taxPercent}
                    onChange={(e) => {
                      const raw = e.target.value;
                      if (PERCENT_PATTERN.test(raw)) setTaxPercent(raw);
                    }}
                  />
                </div>
                <Button
                  type="submit"
                  variant="outline"
                  disabled={!taxFormValid}
                  loading={createTaxRate.isPending}
                >
                  Add tax rate
                </Button>
                {createTaxRate.error ? (
                  <div className="w-full">
                    <ErrorNote error={createTaxRate.error} />
                  </div>
                ) : null}
              </form>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Dialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New product or service"
        description="Adds an item to the catalog. Income and expense accounts control where its sales and costs post."
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            createProduct.mutate(form);
          }}
        >
          {formFields('new-product', 'create')}
          {createProduct.error ? <ErrorNote error={createProduct.error} /> : null}
          <Button type="submit" loading={createProduct.isPending} className="w-full">
            Create product
          </Button>
        </form>
      </Dialog>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title="Edit product"
        description={editing ? editing.name : undefined}
      >
        {editing ? (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              updateProduct.mutate({ id: editing.id, form });
            }}
          >
            {formFields('edit-product', 'edit')}
            {updateProduct.error ? <ErrorNote error={updateProduct.error} /> : null}
            <Button type="submit" loading={updateProduct.isPending} className="w-full">
              Save changes
            </Button>
          </form>
        ) : null}
      </Dialog>
    </div>
  );
}
