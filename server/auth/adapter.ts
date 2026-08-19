import type { Request } from 'express';

/**
 * Application auth adapter boundary. The rest of the server never talks to a
 * provider SDK directly.
 *
 * Modes:
 *  - clerk:    production/development with Clerk credentials configured
 *  - test:     NODE_ENV=test only; header-driven identities for automated tests
 *  - disabled: no provider configured; every authenticated surface fails
 *              closed with AUTH_NOT_CONFIGURED (no fallback login exists)
 */
export interface AuthenticatedIdentity {
  /** Stable provider user id (users.auth_provider_id). */
  authProviderId: string;
  /** Verified primary email. Unverified emails are never returned. */
  email: string;
  emailVerified: boolean;
  name?: string;
  imageUrl?: string;
}

export interface AuthAdapter {
  readonly mode: 'clerk' | 'test' | 'disabled';
  /** Returns the verified identity for the request, or null when anonymous. */
  authenticate(req: Request): Promise<AuthenticatedIdentity | null>;
  /** Client-safe configuration for the login UI. */
  clientConfig(): { mode: 'clerk' | 'test' | 'disabled'; publishableKey?: string };
}
