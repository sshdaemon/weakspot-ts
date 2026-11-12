import { defineConfig } from 'vitest/config';

// Contract tests run real git, the TypeScript resolver, and Stryker with Vitest on fixture projects; the Stryker ones need the long timeout.
export default defineConfig({
  test: {
    include: ['test/contract/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 300_000,
    hookTimeout: 60_000,
    // A contract test checks that a run leaves node_modules caches untouched; this runner must not write there either.
    fsModuleCache: false,
  },
});
