import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { Table, TBody, TD, TDMoney, TFoot, TH, THead, TR } from '@/components/ui/table';

interface ValuationRow {
  productId: string;
  name: string;
  sku: string | null;
  unitLabel: string | null;
  quantityOnHand: string;
  value: string;
  averageCost: string;
}

interface Valuation {
  rows: ValuationRow[];
  totalValue: string;
  ledgerBalance: string;
  tiesToLedger: boolean;
}

interface Adjustment {
  id: string;
  productId: string;
  productName: string;
  adjustmentDate: string;
  direction: 'increase' | 'decrease';
  quantity: string;
  unitCost: string | null;
  totalValue: string;
  reason: string;
  createdByName: string | null;
  createdAt: string;
}

interface Product {
  id: string;
  type: 'service' | 'non_inventory' | 'inventory';
  name: string;
  active: boolean;
}

const QTY_PATTERN = /^\d*(\.\d{0,4})?$/;
const PRICE_PATTERN = /^\d*(\.\d{0,2})?$/;

export function InventoryPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const currency = me.company?.homeCurrency ?? 'USD';
  const canAdjust = can(me, 'products.edit');

  const valuation = useQuery({
    queryKey: ['inventory-valuation'],
    queryFn: () => api.get<Valuation>('/api/v1/inventory/valuation'),
  });
  const adjustments = useQuery({
    queryKey: ['inventory-adjustments'],
    queryFn: () => api.get<{ items: Adjustment[] }>('/api/v1/inventory/adjustments'),
  });
  const products = useQuery({
    queryKey: ['products'],
    queryFn: () => api.get<{ items: Product[] }>('/api/v1/products'),
    enabled: canAdjust,
  });
  const inventoryProducts = (products.data?.items ?? []).filter(
    (p) => p.type === 'inventory' && p.active,
  );

  // ----- adjustment dialog state -----
  const [open, setOpen] = useState(false);
  const [productId, setProductId] = useState('');
  const [adjustmentDate, setAdjustmentDate] = useState(todayISO());
  const [direction, setDirection] = useState<'increase' | 'decrease'>('decrease');
  const [quantity, setQuantity] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [reason, setReason] = useState('');

  function resetForm() {
    setProductId('');
    setAdjustmentDate(todayISO());
    setDirection('decrease');
    setQuantity('');
    setUnitCost('');
    setReason('');
  }

  const canSave =
    productId !== '' &&
    adjustmentDate !== '' &&
    QTY_PATTERN.test(quantity) &&
    quantity.trim() !== '' &&
    Number.parseInt(quantity.replace('.', '') || '0', 10) !== 0 &&
    reason.trim().length >= 3 &&
    (direction === 'decrease' || (unitCost.trim() !== '' && PRICE_PATTERN.test(unitCost)));

  const adjust = useMutation({
    mutationFn: () =>
      api.post<{ id: string; totalValue: string }>('/api/v1/inventory/adjustments', {
        productId,
        adjustmentDate,
        direction,
        quantity: quantity.trim(),
        unitCost: direction === 'increase' ? unitCost.trim() : undefined,
        reason: reason.trim(),
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: (data) => {
      toast('success', `Adjustment posted (${formatMoney(data.totalValue, currency)})`);
      setOpen(false);
      resetForm();
      void qc.invalidateQueries({ queryKey: ['inventory-valuation'] });
      void qc.invalidateQueries({ queryKey: ['inventory-adjustments'] });
    },
  });

  if (valuation.isLoading) return <Spinner label="Loading inventory" />;
  if (valuation.error) return <ErrorNote error={valuation.error} />;
  const data = valuation.data;

  return (
    <div>
      <PageHeader
        title="Inventory"
        description="Perpetual FIFO stock: bills receive layers, invoices relieve them at exact cost, adjustments handle counts and shrinkage."
        actions={
          canAdjust ? (
            <Button
              onClick={() => {
                adjust.reset();
                resetForm();
                setOpen(true);
              }}
              disabled={inventoryProducts.length === 0}
            >
              Adjust quantity
            </Button>
          ) : undefined
        }
      />

      {data ? (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Valuation
              {data.tiesToLedger ? (
                <Badge tone="success">Ties to ledger</Badge>
              ) : (
                <Badge tone="danger">Does not tie to ledger</Badge>
              )}
            </CardTitle>
            <CardDescription>
              Remaining FIFO layer value {formatMoney(data.totalValue, currency)} · Inventory Asset
              ledger balance {formatMoney(data.ledgerBalance, currency)}. These must always be
              equal; a difference means the books need investigation before anything else.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data.rows.length === 0 ? (
              <EmptyState
                title="No inventory products yet"
                description="Create a product with type Inventory, then receive stock with a posted bill or an adjustment."
              />
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Product</TH>
                    <TH>SKU</TH>
                    <TH className="text-right">On hand</TH>
                    <TH className="text-right">Avg cost</TH>
                    <TH className="text-right">Value</TH>
                  </TR>
                </THead>
                <TBody>
                  {data.rows.map((r) => (
                    <TR key={r.productId}>
                      <TD className="font-medium">{r.name}</TD>
                      <TD className="text-muted-foreground">{r.sku ?? '—'}</TD>
                      <TD className="text-right font-mono text-[13px]">
                        {r.quantityOnHand}
                        {r.unitLabel ? ` ${r.unitLabel}` : ''}
                      </TD>
                      <TDMoney>{formatMoney(r.averageCost, currency)}</TDMoney>
                      <TDMoney>{formatMoney(r.value, currency)}</TDMoney>
                    </TR>
                  ))}
                </TBody>
                <TFoot>
                  <TR>
                    <TD
                      colSpan={4}
                      className="text-right text-xs uppercase tracking-wide text-muted-foreground"
                    >
                      Total value
                    </TD>
                    <TDMoney>{formatMoney(data.totalValue, currency)}</TDMoney>
                  </TR>
                </TFoot>
              </Table>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Adjustments</CardTitle>
          <CardDescription>
            Every adjustment posts to the protected Inventory Adjustments account with a required
            reason and lands in the audit log.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {adjustments.data && adjustments.data.items.length === 0 ? (
            <EmptyState
              title="No adjustments yet"
              description="Use Adjust quantity to record shrinkage, damage, or count corrections."
            />
          ) : adjustments.data ? (
            <Table>
              <THead>
                <TR>
                  <TH>Date</TH>
                  <TH>Product</TH>
                  <TH>Direction</TH>
                  <TH className="text-right">Quantity</TH>
                  <TH className="text-right">Value</TH>
                  <TH>Reason</TH>
                  <TH>By</TH>
                </TR>
              </THead>
              <TBody>
                {adjustments.data.items.map((a) => (
                  <TR key={a.id}>
                    <TD className="text-muted-foreground">{formatDate(a.adjustmentDate)}</TD>
                    <TD className="font-medium">{a.productName}</TD>
                    <TD>
                      {a.direction === 'increase' ? (
                        <Badge tone="success">Increase</Badge>
                      ) : (
                        <Badge tone="warning">Decrease</Badge>
                      )}
                    </TD>
                    <TD className="text-right font-mono text-[13px]">{a.quantity}</TD>
                    <TDMoney>{formatMoney(a.totalValue, currency)}</TDMoney>
                    <TD className="max-w-72 text-muted-foreground">{a.reason}</TD>
                    <TD className="text-muted-foreground">{a.createdByName ?? '—'}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          ) : adjustments.error ? (
            <ErrorNote error={adjustments.error} />
          ) : (
            <Spinner label="Loading adjustments" />
          )}
        </CardContent>
      </Card>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) resetForm();
        }}
        title="Adjust inventory quantity"
        description="Decreases relieve the oldest FIFO layers at their exact cost; increases add a new layer at the cost you state."
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            adjust.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="adj-product">Product</Label>
            <Select
              id="adj-product"
              required
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
            >
              <option value="" disabled>
                Select an inventory product…
              </option>
              {inventoryProducts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="adj-date">Date</Label>
              <Input
                id="adj-date"
                type="date"
                required
                value={adjustmentDate}
                onChange={(e) => setAdjustmentDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="adj-direction">Direction</Label>
              <Select
                id="adj-direction"
                value={direction}
                onChange={(e) => setDirection(e.target.value as 'increase' | 'decrease')}
              >
                <option value="decrease">Decrease (shrinkage, damage, count down)</option>
                <option value="increase">Increase (found stock, count up)</option>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="adj-qty">Quantity</Label>
              <MoneyInput
                id="adj-qty"
                required
                placeholder="0"
                value={quantity}
                onChange={(e) => {
                  if (QTY_PATTERN.test(e.target.value)) setQuantity(e.target.value);
                }}
              />
            </div>
            {direction === 'increase' ? (
              <div className="space-y-1.5">
                <Label htmlFor="adj-cost">Unit cost</Label>
                <MoneyInput
                  id="adj-cost"
                  required
                  placeholder="0.00"
                  value={unitCost}
                  onChange={(e) => {
                    if (PRICE_PATTERN.test(e.target.value)) setUnitCost(e.target.value);
                  }}
                />
              </div>
            ) : (
              <p className="self-end pb-2 text-xs text-muted-foreground">
                Cost comes from the oldest layers (FIFO); negative stock is rejected.
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="adj-reason">Reason (required, audited)</Label>
            <Textarea
              id="adj-reason"
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Damaged in storage — discarded two units"
            />
          </div>
          {adjust.error ? <ErrorNote error={adjust.error} /> : null}
          <div className="flex justify-end">
            <Button type="submit" disabled={!canSave} loading={adjust.isPending}>
              Post adjustment
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
