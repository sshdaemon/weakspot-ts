import { expect, it, vi } from 'vitest';
import type { LineRange } from './types-only';
import { remote } from './mocked';

vi.mock('./mocked', () => ({ remote: () => 7 }));

it('uses the mocked remote', () => {
  const r: LineRange = { start: 1, end: 2 };
  expect(remote(r.end)).toBe(7);
});
