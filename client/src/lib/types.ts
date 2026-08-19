/** Shared client-side types mirroring the API contracts. */

export interface AuthConfig {
  mode: 'clerk' | 'test' | 'disabled';
  publishableKey?: string;
  bootstrapped: boolean;
}

export interface BrandBootstrap {
  configured: boolean;
  displayName: string | null;
  applicationName: string | null;
  tokens: Record<string, string>;
  themeMode: 'light' | 'dark' | 'system';
  radius: string;
  brandVersion: number;
}

export interface Me {
  authMode: 'clerk' | 'test' | 'disabled';
  authenticated: boolean;
  bootstrapped: boolean;
  user?: { id: string; email: string; name: string | null; imageUrl: string | null } | null;
  member?: boolean;
  org?: {
    organizationId: string;
    roleKey: string;
    roleName: string;
    permissions: string[];
  } | null;
  company?: {
    displayName: string;
    applicationName: string;
    onboardingStep: string;
    onboardingCompleted: boolean;
    homeCurrency: string;
    fiscalYearStartMonth: number;
    dateFormat: string;
  } | null;
}

export function can(me: Me | undefined, permission: string): boolean {
  const perms = me?.org?.permissions;
  if (!perms) return false;
  return perms.includes('*') || perms.includes(permission);
}
