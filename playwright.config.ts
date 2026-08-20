import { defineConfig } from '@playwright/test';
import fs from 'node:fs';

/**
 * E2E runs against the REAL production build served by the Express app in
 * NODE_ENV=test, with the test-only auth adapter (identities arrive via the
 * browser context's extra headers). The database is a freshly migrated
 * TEST_DATABASE_URL (see tests/e2e/global-setup.ts).
 */
const PORT = 5099;
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/ledgeros_test';

export const E2E_OWNER = {
  authProviderId: 'test|e2e-owner',
  email: 'e2e-owner@example.test',
  emailVerified: true,
  name: 'Evan Owner',
};

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    extraHTTPHeaders: { 'x-test-auth': JSON.stringify(E2E_OWNER) },
    screenshot: 'only-on-failure',
    // Use the environment's pre-installed Chromium when the pinned
    // @playwright/test revision differs from it (never re-download browsers).
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : fs.existsSync('/opt/pw-browsers/chromium')
        ? { executablePath: '/opt/pw-browsers/chromium' }
        : {},
  },
  webServer: {
    command: 'node dist/server/index.mjs',
    url: `http://127.0.0.1:${PORT}/health/live`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      NODE_ENV: 'test',
      PORT: String(PORT),
      TEST_DATABASE_URL,
      APP_BASE_URL: `http://127.0.0.1:${PORT}`,
      BOOTSTRAP_OWNER_EMAIL: E2E_OWNER.email,
      LOG_LEVEL: 'error',
    },
  },
});
