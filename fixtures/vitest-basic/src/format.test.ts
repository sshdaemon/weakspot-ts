import { expect, it } from 'vitest';
import { priceLine } from './format';

it('joins the name and the price', () => expect(priceLine('Tea', 250)).toBe('Tea: £2.50'));
