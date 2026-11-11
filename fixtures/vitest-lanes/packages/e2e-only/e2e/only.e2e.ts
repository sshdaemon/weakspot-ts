import { expect, test } from 'vitest';
import { sign } from '../src/only.ts';

test('sign', () => {
  expect(sign(-5)).toBe(-1);
  expect(sign(5)).toBe(1);
  expect(sign(0)).toBe(0);
});
