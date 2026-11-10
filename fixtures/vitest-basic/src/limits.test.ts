import { expect, it } from 'vitest';
import { LIMIT } from './limits';

// Deliberately weak: only the type is checked, so the static mutants on LIMIT survive.
it('is a number', () => expect(typeof LIMIT).toBe('number'));
