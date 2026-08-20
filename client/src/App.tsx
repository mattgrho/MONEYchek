import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthModeProvider, useAuthConfig, useInvalidateMe, useMe } from '@/lib/auth';
import { can } from '@/lib/types';
import { Spinner } from '@/components/ui/primitives';
import { AppShell } from '@/components/AppShell';
import {
  AcceptInvitationPage,
  AuthNotConfiguredPage,
  ClaimDeploymentPage,
  LoginPage,
  NoAccessPage,
} from '@/pages/gates';
import { DashboardPage } from '@/pages/DashboardPage';
import { OnboardingPage } from '@/pages/OnboardingPage';
import { UsersSettingsPage } from '@/pages/settings/UsersSettingsPage';
import { CompanySettingsPage } from '@/pages/settings/CompanySettingsPage';
import { BrandSettingsPage } from '@/pages/settings/BrandSettingsPage';
import { CustomersPage } from '@/pages/sales/CustomersPage';
import { ProductsPage } from '@/pages/sales/ProductsPage';
import { EstimatesPage } from '@/pages/sales/EstimatesPage';
import { EstimateDetailPage } from '@/pages/sales/EstimateDetailPage';
import { InvoicesPage } from '@/pages/sales/InvoicesPage';
import { InvoiceDetailPage } from '@/pages/sales/InvoiceDetailPage';
import { PaymentsPage } from '@/pages/sales/PaymentsPage';
import { CreditMemosPage } from '@/pages/sales/CreditMemosPage';
import { DepositsPage } from '@/pages/sales/DepositsPage';
import { SalesReceiptsPage } from '@/pages/sales/SalesReceiptsPage';
import { AccountsPage } from '@/pages/accounting/AccountsPage';
import { AccountRegisterPage } from '@/pages/accounting/AccountRegisterPage';
import { JournalsPage } from '@/pages/accounting/JournalsPage';
import { PeriodsPage } from '@/pages/accounting/PeriodsPage';
import { ReportsHubPage } from '@/pages/reports/ReportsHubPage';
import { TrialBalancePage } from '@/pages/reports/TrialBalancePage';
import { ProfitLossPage } from '@/pages/reports/ProfitLossPage';
import { BalanceSheetPage } from '@/pages/reports/BalanceSheetPage';
import { GeneralLedgerPage } from '@/pages/reports/GeneralLedgerPage';
import { JournalReportPage } from '@/pages/reports/JournalReportPage';
import { AuditLogPage } from '@/pages/reports/AuditLogPage';

function FullScreenSpinner() {
  return (
    <div className="flex min-h-full items-center justify-center">
      <Spinner label="Loading" />
    </div>
  );
}

function Gate() {
  const { data: me, isLoading, error } = useMe();
  const invalidateMe = useInvalidateMe();
  if (isLoading) return <FullScreenSpinner />;
  if (error || !me) return <AuthNotConfiguredPage />;

  if (!me.authenticated) {
    return <LoginPage mode={me.authMode} />;
  }
  if (!me.bootstrapped) {
    return <ClaimDeploymentPage />;
  }
  if (!me.member) {
    return (
      <Routes>
        <Route path="/accept-invitation" element={<AcceptInvitationPage />} />
        <Route path="*" element={<NoAccessPage />} />
      </Routes>
    );
  }
  if (me.company && !me.company.onboardingCompleted && can(me, 'company.edit')) {
    return <OnboardingPage me={me} onDone={() => void invalidateMe()} />;
  }

  return (
    <AppShell me={me}>
      <Routes>
        <Route path="/" element={<DashboardPage me={me} />} />
        <Route path="/sales/customers" element={<CustomersPage me={me} />} />
        <Route path="/sales/products" element={<ProductsPage me={me} />} />
        <Route path="/sales/estimates" element={<EstimatesPage me={me} />} />
        <Route path="/sales/estimates/:id" element={<EstimateDetailPage me={me} />} />
        <Route path="/sales/invoices" element={<InvoicesPage me={me} />} />
        <Route path="/sales/invoices/:id" element={<InvoiceDetailPage me={me} />} />
        <Route path="/sales/payments" element={<PaymentsPage me={me} />} />
        <Route path="/sales/credits" element={<CreditMemosPage me={me} />} />
        <Route path="/sales/deposits" element={<DepositsPage me={me} />} />
        <Route path="/sales/receipts" element={<SalesReceiptsPage me={me} />} />
        <Route path="/accounting/accounts" element={<AccountsPage me={me} />} />
        <Route path="/accounting/accounts/:id/register" element={<AccountRegisterPage me={me} />} />
        <Route path="/accounting/journals" element={<JournalsPage me={me} />} />
        <Route path="/accounting/periods" element={<PeriodsPage me={me} />} />
        <Route path="/reports" element={<ReportsHubPage me={me} />} />
        <Route path="/reports/trial-balance" element={<TrialBalancePage me={me} />} />
        <Route path="/reports/profit-and-loss" element={<ProfitLossPage me={me} />} />
        <Route path="/reports/balance-sheet" element={<BalanceSheetPage me={me} />} />
        <Route path="/reports/general-ledger" element={<GeneralLedgerPage me={me} />} />
        <Route path="/reports/journal" element={<JournalReportPage me={me} />} />
        <Route path="/reports/audit-log" element={<AuditLogPage me={me} />} />
        <Route path="/settings/company" element={<CompanySettingsPage me={me} />} />
        <Route path="/settings/brand" element={<BrandSettingsPage me={me} />} />
        <Route path="/settings/users" element={<UsersSettingsPage me={me} />} />
        <Route path="/accept-invitation" element={<AcceptInvitationPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}

export default function App() {
  const { data: config, isLoading } = useAuthConfig();
  if (isLoading) return <FullScreenSpinner />;
  if (!config || config.mode === 'disabled') return <AuthNotConfiguredPage />;
  return (
    <AuthModeProvider config={config}>
      <Gate />
    </AuthModeProvider>
  );
}
