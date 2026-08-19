import type { Request } from 'express';
import type { AuthAdapter } from './adapter';
import { getEnv } from '../config/env';

let adapter: AuthAdapter | null = null;

const disabledAdapter: AuthAdapter = {
  mode: 'disabled',
  clientConfig() {
    return { mode: 'disabled' };
  },
  async authenticate(_req: Request) {
    return null;
  },
};

/**
 * Adapter selection is environment-driven and fail-closed:
 *  - NODE_ENV=test           -> test adapter (dynamic import; module refuses
 *                               to load in any other environment)
 *  - Clerk keys configured   -> Clerk adapter
 *  - otherwise               -> disabled (setup notice; APIs return 503)
 */
export async function getAuthAdapter(): Promise<AuthAdapter> {
  if (adapter) return adapter;
  const env = getEnv();
  if (env.NODE_ENV === 'test') {
    const { createTestAdapter } = await import('./test-adapter');
    adapter = createTestAdapter();
  } else if (env.CLERK_SECRET_KEY && env.CLERK_PUBLISHABLE_KEY) {
    const { createClerkAdapter } = await import('./clerk-adapter');
    adapter = createClerkAdapter({
      secretKey: env.CLERK_SECRET_KEY,
      publishableKey: env.CLERK_PUBLISHABLE_KEY,
    });
  } else {
    adapter = disabledAdapter;
  }
  return adapter;
}
