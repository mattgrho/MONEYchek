import type { Request } from 'express';
import { createClerkClient } from '@clerk/backend';
import type { AuthAdapter, AuthenticatedIdentity } from './adapter';
import { logger } from '../lib/logger';

/**
 * Clerk-backed adapter. Verifies the request session token with Clerk and
 * resolves the user's verified primary email. User details are cached
 * per-process for a short interval to avoid a provider round trip on every
 * request.
 */
export function createClerkAdapter(options: {
  secretKey: string;
  publishableKey: string;
}): AuthAdapter {
  const clerk = createClerkClient({
    secretKey: options.secretKey,
    publishableKey: options.publishableKey,
  });
  const cache = new Map<string, { identity: AuthenticatedIdentity; expiresAt: number }>();
  const CACHE_TTL_MS = 60_000;

  return {
    mode: 'clerk',
    clientConfig() {
      return { mode: 'clerk', publishableKey: options.publishableKey };
    },
    async authenticate(req: Request): Promise<AuthenticatedIdentity | null> {
      try {
        const url = new URL(req.originalUrl, 'http://internal');
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === 'string') headers.set(k, v);
          else if (Array.isArray(v)) headers.set(k, v.join(','));
        }
        const state = await clerk.authenticateRequest(
          new Request(url, { headers, method: req.method }),
        );
        if (!state.isSignedIn) return null;
        const auth = state.toAuth();
        const userId = auth.userId;
        if (!userId) return null;

        const cached = cache.get(userId);
        if (cached && cached.expiresAt > Date.now()) return cached.identity;

        const user = await clerk.users.getUser(userId);
        const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId);
        if (!primary || primary.verification?.status !== 'verified') {
          // Unverified emails never authenticate: bootstrap and invitations
          // depend on verified identity.
          return null;
        }
        const identity: AuthenticatedIdentity = {
          authProviderId: user.id,
          email: primary.emailAddress.toLowerCase(),
          emailVerified: true,
          name: [user.firstName, user.lastName].filter(Boolean).join(' ') || undefined,
          imageUrl: user.imageUrl || undefined,
        };
        cache.set(userId, { identity, expiresAt: Date.now() + CACHE_TTL_MS });
        return identity;
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'clerk authentication failed');
        return null;
      }
    },
  };
}
