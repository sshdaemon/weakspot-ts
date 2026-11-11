import { expect, it, vi } from 'vitest';
import { viaRemote } from './via';

// Mocks a module reached only through via.ts: at depth 2 this spec must not count as mocked.ts's spec.
vi.mock('./mocked', () => ({ remote: () => 1 }));

it('adds one to the mocked remote', () => expect(viaRemote(5)).toBe(2));
