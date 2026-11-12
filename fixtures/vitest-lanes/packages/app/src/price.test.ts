import { expect, test } from 'vitest';
import { discounted } from './price.ts';

test('discounted', () => {
  expect(discounted(1000, 0)).toBe(1000);
  expect(discounted(1000, 25)).toBe(750);
  expect(discounted(999, 33)).toBe(669);
});
