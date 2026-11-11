import { expect, it, vi } from 'vitest';
import { discounted } from './price';

// Imported relatively, mocked through the alias: the same module either way.
vi.mock('@/price', () => ({ discounted: () => 0, label: () => '' }));

it('uses the mocked discount', () => expect(discounted(100, 10)).toBe(0));
