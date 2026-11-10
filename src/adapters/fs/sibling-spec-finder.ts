import { existsSync } from 'node:fs';
import path from 'node:path';
import { repoRelative } from '../../change/paths.ts';
import type { SpecSet } from '../../change/types.ts';
import type { SpecFinder } from '../../ports/spec-finder.ts';

const SIBLING_SUFFIXES = ['.spec.ts', '.test.ts', '.spec.tsx', '.test.tsx'];

/** Explicit specs win; else a sibling `<name>.spec.ts` or `.test.ts`, also under `__tests__/`. */
export class SiblingSpecFinder implements SpecFinder {
  find(repoRoot: string, file: string, explicit: readonly string[]): SpecSet {
    if (explicit.length > 0) return { file, specs: [...explicit], how: 'explicit' };
    const abs = path.join(repoRoot, file);
    const dir = path.dirname(abs);
    const base = path.basename(abs).replace(/\.(ts|tsx)$/, '');
    const candidates = SIBLING_SUFFIXES.flatMap((s) => [path.join(dir, base + s), path.join(dir, '__tests__', base + s)]);
    const found = candidates.filter((c) => existsSync(c)).map((c) => repoRelative(repoRoot, c));
    return { file, specs: found, how: found.length > 0 ? 'sibling' : 'none' };
  }
}
