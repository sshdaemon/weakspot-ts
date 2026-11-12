import { defineConfig } from 'vitest/config';

// Reads env at load, like a real e2e config choosing a database: the shim must set it before this runs.
const db = process.env.FIXTURE_DB ?? 'unset';

export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.ts'],
    environment: 'node',
    pool: 'forks',
    globalSetup: ['./e2e/global-setup.ts'],
    env: { FIXTURE_DB_SEEN_BY_CONFIG: db },
  },
});
