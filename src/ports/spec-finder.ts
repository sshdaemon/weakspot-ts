import type { SpecSet } from '../change/types.ts';

/** Answers which specs constrain a source file. Sibling lookup today; import resolution later. */
export interface SpecFinder {
  find(repoRoot: string, file: string, explicit: readonly string[]): SpecSet;
}
