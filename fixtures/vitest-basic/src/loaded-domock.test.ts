import { expect, test, vi } from 'vitest';

test('vi.doMock replaces the module, so this spec never runs its code', async () => {
  vi.doMock('./loaded.ts', () => ({ double: () => 0 }));
  const { double } = await import('./loaded.ts');
  expect(double(5)).toBe(0);
});
