import type { Package, SpecSet } from '../change/types.ts';

/** Answers which specs constrain a source file, within its package. */
export interface SpecFinder {
  find(repoRoot: string, pkg: Package, file: string, explicit: readonly string[]): SpecSet;
}

/** Answers which sources a spec imports (mocked and type-only ones excluded), for the changed-spec rule. */
export interface ImportsReader {
  importsOf(repoRoot: string, pkg: Package, absSpec: string): string[];
}
