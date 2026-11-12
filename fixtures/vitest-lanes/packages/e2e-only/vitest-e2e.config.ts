import { defineConfig } from 'vitest/config';

// A package with no unit config at all: only the e2e lane can run it.
export default defineConfig({
  test: { include: ['e2e/**/*.e2e.ts'], environment: 'node', pool: 'forks' },
});
