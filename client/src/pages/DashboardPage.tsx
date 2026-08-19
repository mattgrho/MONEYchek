import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Me } from '@/lib/types';
import { can } from '@/lib/types';
import { formatMoney } from '@/lib/utils';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  PageHeader,
  Spinner,
} from '@/components/ui/primitives';

interface DashboardData {
  bankAccounts: { accountId: string; name: string; balance: string }[];
  arOpenTotal: string;
  arOverdueTotal: string;
  apOpenTotal: string;
  apOverdueTotal: string;
  undepositedFunds: string;
  counts: {
    customers: number;
    vendors: number;
    accounts: number;
    invoicesOpen: number;
    billsOpen: number;
    bankItemsToReview: number;
  };
}

/**
 * Dashboard widgets read the same reporting services as the detail pages —
 * there are no independent totals here.
 */
export function DashboardPage({ me }: { me: Me }) {
  const { data, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashboardData>('/api/v1/dashboard'),
  });

  if (isLoading || !data) return <Spinner label="Loading dashboard" />;
  const currency = me.company?.homeCurrency ?? 'USD';

  return (
    <div>
      <PageHeader
        title="Overview"
        description={`Today's position for ${me.company?.displayName ?? 'your company'}.`}
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Open receivables</CardTitle>
          </CardHeader>
          <CardContent>
            <p data-money className="text-2xl font-semibold tabular-nums">
              {formatMoney(data.arOpenTotal, currency)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              <span data-money>{formatMoney(data.arOverdueTotal, currency)}</span> overdue ·{' '}
              <Link to="/sales/invoices" className="text-primary underline">
                {data.counts.invoicesOpen} open invoices
              </Link>
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Open payables</CardTitle>
          </CardHeader>
          <CardContent>
            <p data-money className="text-2xl font-semibold tabular-nums">
              {formatMoney(data.apOpenTotal, currency)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              <span data-money>{formatMoney(data.apOverdueTotal, currency)}</span> overdue ·{' '}
              <Link to="/expenses/bills" className="text-primary underline">
                {data.counts.billsOpen} open bills
              </Link>
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Undeposited funds</CardTitle>
          </CardHeader>
          <CardContent>
            <p data-money className="text-2xl font-semibold tabular-nums">
              {formatMoney(data.undepositedFunds, currency)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              <Link to="/sales/deposits" className="text-primary underline">
                Group receipts into a deposit
              </Link>
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Bank items to review</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{data.counts.bankItemsToReview}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              <Link to="/banking/review" className="text-primary underline">
                Review imported transactions
              </Link>
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Bank & card balances</CardTitle>
          </CardHeader>
          <CardContent>
            {data.bankAccounts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No bank or credit-card accounts yet.{' '}
                {can(me, 'accounts.create') ? (
                  <Link to="/accounting/accounts" className="text-primary underline">
                    Add one in the chart of accounts.
                  </Link>
                ) : null}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {data.bankAccounts.map((a) => (
                  <li key={a.accountId} className="flex items-center justify-between py-2 text-sm">
                    <Link
                      to={`/banking/registers?account=${a.accountId}`}
                      className="hover:underline"
                    >
                      {a.name}
                    </Link>
                    <span data-money className="font-mono tabular-nums">
                      {formatMoney(a.balance, currency)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Company records</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              <li className="flex justify-between">
                <Link to="/sales/customers" className="hover:underline">
                  Customers
                </Link>
                <span className="tabular-nums">{data.counts.customers}</span>
              </li>
              <li className="flex justify-between">
                <Link to="/expenses/vendors" className="hover:underline">
                  Vendors
                </Link>
                <span className="tabular-nums">{data.counts.vendors}</span>
              </li>
              <li className="flex justify-between">
                <Link to="/accounting/accounts" className="hover:underline">
                  Active accounts
                </Link>
                <span className="tabular-nums">{data.counts.accounts}</span>
              </li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
