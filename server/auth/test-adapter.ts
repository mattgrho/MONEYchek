import type { Request } from 'express';
import { z } from 'zod';
import type { AuthAdapter, AuthenticatedIdentity } from './adapter';

/**
 * Test-only auth adapter. Identities arrive in the `x-test-auth` header as
 * JSON. This module refuses to load outside NODE_ENV=test — it can never be
 * bundled into a production auth path.
 */
if (process.env.NODE_ENV !== 'test') {
  throw new Error('test auth adapter loaded outside NODE_ENV=test');
}

const TestIdentitySchema = z.object({
  authProviderId: z.string().min(1),
  email: z.string().email(),
  emailVerified: z.boolean().default(true),
  name: z.string().optional(),
});

export function createTestAdapter(): AuthAdapter {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('test auth adapter created outside NODE_ENV=test');
  }
  return {
    mode: 'test',
    clientConfig() {
      return { mode: 'test' };
    },
    async authenticate(req: Request): Promise<AuthenticatedIdentity | null> {
      const raw = req.headers['x-test-auth'];
      if (typeof raw !== 'string' || raw.length === 0) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return null;
      }
      const result = TestIdentitySchema.safeParse(parsed);
      if (!result.success) return null;
      const identity = result.data;
      if (!identity.emailVerified) return null;
      return {
        authProviderId: identity.authProviderId,
        email: identity.email.toLowerCase(),
        emailVerified: true,
        name: identity.name,
      };
    },
  };
}
