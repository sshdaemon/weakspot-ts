import { expect, test, vi } from 'vitest';

test('vi.importActual loads the real module', async () => {
  const { double } = await vi.importActual<typeof import('./loaded.ts')>('./loaded.ts');
  expect(double(3)).toBe(6);
});
