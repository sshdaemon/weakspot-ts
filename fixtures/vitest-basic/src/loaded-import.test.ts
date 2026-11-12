import { expect, test } from 'vitest';

test('a dynamic import loads the module', async () => {
  const { double } = await import('./loaded.ts');
  expect(double(2)).toBe(4);
});
