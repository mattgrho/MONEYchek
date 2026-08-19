import { type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ClerkProvider, useAuth } from '@clerk/clerk-react';
import { api, setTokenGetter } from './api';
import type { AuthConfig, Me } from './types';

export function useAuthConfig() {
  return useQuery({
    queryKey: ['auth-config'],
    queryFn: () => api.get<AuthConfig>('/api/public/auth-config'),
    staleTime: Infinity,
  });
}

export function useMe(enabled = true) {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<Me>('/api/v1/me'),
    enabled,
    staleTime: 15_000,
    retry: (count, err) =>
      count < 2 &&
      !(err instanceof Error && 'status' in err && (err as { status: number }).status === 503),
  });
}

export function useInvalidateMe() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['me'] });
}

/** Registers Clerk's token getter with the API client. */
function ClerkTokenBridge({ children }: { children: ReactNode }) {
  const { getToken } = useAuth();
  setTokenGetter(() => getToken());
  return <>{children}</>;
}

/**
 * Wraps the app in the provider demanded by the server's auth mode. In
 * 'disabled' and 'test' modes there is no client SDK; the server decides
 * everything.
 */
export function AuthModeProvider({
  config,
  children,
}: {
  config: AuthConfig;
  children: ReactNode;
}) {
  if (config.mode === 'clerk' && config.publishableKey) {
    return (
      <ClerkProvider publishableKey={config.publishableKey} afterSignOutUrl="/">
        <ClerkTokenBridge>{children}</ClerkTokenBridge>
      </ClerkProvider>
    );
  }
  return <>{children}</>;
}
