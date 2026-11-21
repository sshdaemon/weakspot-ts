import { expect, test } from 'vitest';
import { area, type Shape } from './barrel.ts';

test('area through the barrel', () => {
  const s: Shape = { w: 2, h: 3 };
  expect(area(s.w, s.h)).toBe(6);
});
