import type { Package, SpecSet, TriageDecision } from '../change/types.ts';
import type { Lane, PackagePlan, Target } from './types.ts';

export interface PlanOutcome {
  readonly plans: PackagePlan[];
  /** Kept files with no spec set; reported, not mutated. */
  readonly untested: string[];
  /** Kept files outside any package with a test config. */
  readonly noTestConfig: string[];
}

/**
 * Groups kept files by package. Pure: specs and packages are looked up beforehand.
 * Files without specs or without a package fall out, named.
 */
export function planPackages(
  kept: readonly TriageDecision[],
  specs: ReadonlyMap<string, SpecSet>,
  packages: ReadonlyMap<string, Package | undefined>,
  lane: Lane,
): PlanOutcome {
  const byPkg = new Map<string, { pkg: Package; targets: Target[]; specs: Set<string> }>();
  const untested: string[] = [];
  const noTestConfig: string[] = [];
  for (const d of kept) {
    // No known test config comes first: discovery never ran for such a file, so "untested" would overclaim.
    const pkg = packages.get(d.file.path);
    if (!pkg) {
      noTestConfig.push(d.file.path);
      continue;
    }
    const set = specs.get(d.file.path);
    if (!set || set.specs.length === 0) {
      untested.push(d.file.path);
      continue;
    }
    let entry = byPkg.get(pkg.dir);
    if (!entry) {
      entry = { pkg, targets: [], specs: new Set() };
      byPkg.set(pkg.dir, entry);
    }
    entry.targets.push({ file: d.file.path, ranges: d.file.ranges });
    for (const s of set.specs) entry.specs.add(s);
  }
  const plans = [...byPkg.values()].map((e) => ({ lane, pkg: e.pkg, targets: e.targets, specs: [...e.specs].sort() }));
  return { plans, untested, noTestConfig };
}
