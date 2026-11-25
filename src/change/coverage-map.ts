import path from 'node:path';
import { isInside, repoRelative } from './paths.ts';

/** Which source files each spec of a lane ran, from one run of the lane's whole suite. */
export interface CoverageMap {
  readonly schemaVersion: number;
  /** The repository key the map belongs to. */
  readonly repo: string;
  readonly lane: string;
  /** HEAD when the map was made. */
  readonly commit: string;
  readonly createdAt: string;
  /** Repo-relative folders of the packages whose suites ran, `.` for the root. */
  readonly packages: readonly string[];
  /** Repo-relative spec path to the repo-relative source files it ran, sorted. */
  readonly specs: Readonly<Record<string, readonly string[]>>;
  /** Packages with the lane's config whose suite recorded nothing, so the map knows nothing about them. */
  readonly missing?: readonly string[];
}

export const COVERAGE_MAP_SCHEMA_VERSION = 1;

/**
 * The repo's own source files each spec ran: inside the repo, outside node_modules, and not specs
 * themselves. Paths come in absolute, as the runner reports module ids.
 */
export function mapEntries(executed: ReadonlyMap<string, readonly string[]>, repoRoot: string, isSpec: (repoRelativePath: string) => boolean): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [spec, modules] of executed) {
    if (!isInside(repoRoot, spec)) continue;
    const files = new Set<string>();
    for (const id of modules) {
      if (!path.isAbsolute(id) || !isInside(repoRoot, id)) continue;
      const rel = repoRelative(repoRoot, id);
      if (rel.split('/').includes('node_modules') || isSpec(rel)) continue;
      files.add(rel);
    }
    out[repoRelative(repoRoot, spec)] = [...files].toSorted();
  }
  return out;
}

/** The package folder a repo-relative path belongs to: the longest listed package folder that holds it. */
export function packageOfPath(packages: readonly string[], file: string): string | undefined {
  return packages
    .filter((dir) => dir === '.' || file === dir || file.startsWith(`${dir}/`))
    .toSorted((a, b) => b.length - a.length)[0];
}

/**
 * Specs that ran `file`: those in `pkgDir` (the only ones a package's mutation run can use), and the
 * packages of the others, which run the file, or other code of its package, from outside.
 */
export function coveringSpecs(map: CoverageMap, file: string, pkgDir: string): { inPackage: string[]; fromPackages: string[] } {
  const inPackage: string[] = [];
  const from = new Set<string>();
  // A path is the package's when no nested mapped package holds it more closely.
  const owners = [...map.packages, pkgDir];
  const inside = (p: string) => packageOfPath(owners, p) === pkgDir;
  for (const [spec, files] of Object.entries(map.specs)) {
    const specPkg = packageOfPath(map.packages, spec);
    if (specPkg === pkgDir) {
      if (files.includes(file)) inPackage.push(spec);
    } else if (specPkg && files.some(inside)) {
      from.add(specPkg);
    }
  }
  return { inPackage: inPackage.toSorted(), fromPackages: [...from].toSorted() };
}

/** How old a map is against the checkout: commits behind HEAD (undefined when unknown) and days. */
export function staleness(map: Pick<CoverageMap, 'lane' | 'commit' | 'createdAt'>, head: string, commitsBehind: number | undefined, now: Date): string | undefined {
  if (map.commit === head) return undefined;
  const days = Math.floor((now.getTime() - new Date(map.createdAt).getTime()) / 86_400_000);
  const behind = commitsBehind === undefined ? `at ${map.commit.slice(0, 12)}, not an ancestor of HEAD` : `${commitsBehind} commit(s) ago`;
  return `the ${map.lane} lane's coverage map was made ${behind}, ${days} day(s) old; files added or moved since fall back to the next spec source; weakspot map ${map.lane} refreshes it`;
}
