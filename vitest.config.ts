import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(rootDir, 'client/src'),
      '@shared': path.resolve(rootDir, 'shared'),
      '@server': path.resolve(rootDir, 'server'),
    },
  },
  test: {
    include: [
      'tests/unit/**/*.test.ts',
      'tests/integration/**/*.test.ts',
      'client/src/**/*.test.tsx',
    ],
    environment: 'node',
    globalSetup: ['tests/global-setup.ts'],
    // Integration files share one test database (each truncates in
    // beforeAll), so they must run strictly one at a time. Vitest 4 moved
    // the old poolOptions.forks.singleFork behavior to these top-level
    // options.
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
