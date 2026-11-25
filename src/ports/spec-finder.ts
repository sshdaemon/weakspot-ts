import type { Package, SpecSet } from '../change/types.ts';

/** Answers which specs constrain a source file, within its package. */
export interface SpecFinder {
  find(repoRoot: string, pkg: Package, file: string, explicit: readonly string[]): SpecSet;
  /** Why a file this source has no specs for may still be run by tests, for its untested finding; `pkgDir` is the repo-relative folder of its package.json. */
  explain?(repoRoot: string, file: string, pkgDir: string): string | undefined;
  /** Things to say in the report about the source itself, such as a stale coverage map. */
  warnings?(): string[];
}

/** Answers which sources a spec imports (mocked and type-only ones excluded), for the changed-spec rule. */
export interface ImportsReader {
  importsOf(repoRoot: string, pkg: Package, absSpec: string): string[];
  /** 1-based lines that hold only import declarations or nothing, so an edit there changes no test. */
  importLines(absSpec: string): ReadonlySet<number>;
  /** True when removed text is only import declarations and blank lines; a fragment that does not parse as such is not. */
  onlyImports(text: string): boolean;
}
