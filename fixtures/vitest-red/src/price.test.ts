import { describe, expect, it } from 'vitest';
import { discounted, label } from './price';

describe('discounted', () => {
  it('leaves the price alone at zero percent', () => expect(discounted(1000, 0)).toBe(1000));
  it('is free at a hundred percent', () => expect(discounted(1000, 100)).toBe(0));
  it('rounds to the nearest penny', () => expect(discounted(999, 33)).toBe(670));
});

describe('label', () => {
  // Only the whole-pound branch is tested, on purpose: the fixture must leave survivors.
  it('shows whole pounds', () => expect(label(1000)).toContain('£'));
});
