import { expect, test } from 'vitest';
import { clamp, isEven } from '../src/calc.ts';

test('the lane env reached the config and the workers', () => {
  expect(process.env.FIXTURE_DB_SEEN_BY_CONFIG).toMatch(/^db_\d+$/);
  expect(process.env.FIXTURE_DB).toBe(process.env.FIXTURE_DB_SEEN_BY_CONFIG);
});

test('clamp', () => {
  expect(clamp(5, 1, 10)).toBe(5);
  expect(clamp(-1, 1, 10)).toBe(1);
  expect(clamp(11, 1, 10)).toBe(10);
});

test('isEven, weakly', () => {
  expect(isEven(4)).toBe(true);
});
