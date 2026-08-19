import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthModeProvider, useAuthConfig, useMe } from '@/lib/auth';
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
import { UsersSettingsPage } from '@/pages/settings/UsersSettingsPage';

function FullScreenSpinner() {
  return (
    <div className="flex min-h-full items-center justify-center">
      <Spinner label="Loading" />
    </div>
  );
}

function Gate() {
  const { data: me, isLoading, error } = useMe();
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

  return (
    <AppShell me={me}>
      <Routes>
        <Route path="/" element={<DashboardPage me={me} />} />
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
