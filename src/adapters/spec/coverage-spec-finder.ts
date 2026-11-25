import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { coveringSpecs, staleness, type CoverageMap } from '../../change/coverage-map.ts';
import { repoRelative } from '../../change/paths.ts';
import type { Package, SpecSet } from '../../change/types.ts';
import type { CoverageMapStore } from '../../ports/coverage-map-store.ts';
import type { SpecFinder } from '../../ports/spec-finder.ts';

/** The checkout's HEAD, and how many commits it is ahead of another commit (undefined when that one is not an ancestor). */
export interface HeadInfo {
  head(repoRoot: string): string;
  commitsSince(repoRoot: string, commit: string): number | undefined;
}

const gitHead: HeadInfo = {
  head: (repoRoot) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
  commitsSince: (repoRoot, commit) => {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], { cwd: repoRoot, stdio: 'ignore' });
      return Number(execFileSync('git', ['rev-list', '--count', `${commit}..HEAD`], { cwd: repoRoot, encoding: 'utf8' }).trim());
    } catch {
      return undefined;
    }
  },
};

/**
 * A lane's `"coverage"` source: the specs of the file's own package that ran the file when the lane's
 * suite was last mapped. Specs since deleted are dropped; a file the map lacks has none, so the next
 * source answers. The map is read once per run; its age is a report warning, never a refusal.
 */
export class CoverageSpecFinder implements SpecFinder {
  private readonly store: CoverageMapStore;
  private readonly repo: string;
  private readonly lane: string;
  private readonly git: HeadInfo;
  private readonly now: () => Date;
  private loaded: { map: CoverageMap | undefined; warning: string | undefined } | undefined;

  constructor(store: CoverageMapStore, repo: string, lane: string, git: HeadInfo = gitHead, now: () => Date = () => new Date()) {
    this.store = store;
    this.repo = repo;
    this.lane = lane;
    this.git = git;
    this.now = now;
  }

  find(repoRoot: string, pkg: Package, file: string): SpecSet {
    const map = this.load(repoRoot);
    if (!map) return { file, specs: [], how: 'none' };
    const { inPackage } = coveringSpecs(map, file, repoRelative(repoRoot, pkg.dir) || '.');
    const specs = inPackage.filter((s) => existsSync(path.join(repoRoot, s)));
    return { file, specs, how: specs.length > 0 ? 'coverage' : 'none' };
  }

  explain(repoRoot: string, file: string, pkgDir: string): string | undefined {
    const map = this.load(repoRoot);
    if (!map) return undefined;
    if (map.missing?.includes(pkgDir)) return `the ${this.lane} lane's coverage map has no record of ${pkgDir}: its suite recorded nothing when the map was made`;
    const { fromPackages } = coveringSpecs(map, file, pkgDir);
    if (fromPackages.length === 0) return undefined;
    return `the ${this.lane} lane's coverage map shows specs in ${fromPackages.join(', ')} running code of ${pkgDir}, but mutants run against the specs of their own package`;
  }

  warnings(): string[] {
    const missing = this.loaded?.map?.missing ?? [];
    const gap = missing.length > 0 ? [`the ${this.lane} lane's coverage map has no record of ${missing.join(', ')}, whose suites recorded nothing; weakspot map ${this.lane} tries again`] : [];
    return [...(this.loaded?.warning ? [this.loaded.warning] : []), ...gap];
  }

  private load(repoRoot: string): CoverageMap | undefined {
    if (!this.loaded) {
      const map = this.store.read(this.repo, this.lane);
      const warning = map
        ? staleness(map, this.git.head(repoRoot), this.git.commitsSince(repoRoot, map.commit), this.now())
        : `the ${this.lane} lane lists coverage as a spec source but has no coverage map yet; weakspot map ${this.lane} makes one`;
      this.loaded = { map, warning };
    }
    return this.loaded.map;
  }
}
