import type { Package } from '../change/types.ts';

/** Finds the repo root and the package (with a test config) that owns a file. */
export interface PackageLocator {
  repoRoot(start: string): string;
  packageOf(repoRoot: string, absFile: string): Package | undefined;
}
