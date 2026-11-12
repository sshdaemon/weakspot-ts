import { createRequire } from 'node:module';
import { expect, test } from 'vitest';

const require = createRequire(import.meta.url);

test('require loads the module', () => {
  const { double } = require('./loaded.ts') as typeof import('./loaded.ts');
  expect(double(4)).toBe(8);
});
