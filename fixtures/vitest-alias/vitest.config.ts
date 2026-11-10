import { defineConfig } from 'vitest/config';

// A function config with an absolute alias into the project, the shape that made every
// mutant survive before the shim rebased aliases onto the sandbox.
export default defineConfig(() => ({
  resolve: { alias: [{ find: /^@\//, replacement: `${import.meta.dirname}/src/` }] },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
}));
