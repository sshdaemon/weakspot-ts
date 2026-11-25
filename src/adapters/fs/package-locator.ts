import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isInside } from '../../change/paths.ts';
import type { Package } from '../../change/types.ts';
import type { PackageLocator } from '../../ports/package-locator.ts';
import { GitError } from '../git/git-change-source.ts';

const VITEST_CONFIGS = ['mts', 'ts', 'cts', 'mjs', 'js', 'cjs'].map((e) => `vitest.config.${e}`);
const JEST_CONFIGS = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs', 'json'].map((e) => `jest.config.${e}`);
const VITE_CONFIGS = ['mts', 'ts', 'cts', 'mjs', 'js', 'cjs'].map((e) => `vite.config.${e}`);

/**
 * The unit lane's config names, in the order they decide a package's runner: a Vitest config, then a
 * Jest one (or a `jest` key in package.json, checked right after), then a Vite config, which a Jest
 * project may keep for its build alone.
 */
export const UNIT_TEST_CONFIGS = [...VITEST_CONFIGS, ...JEST_CONFIGS, ...VITE_CONFIGS];

export class FsPackageLocator implements PackageLocator {
  private readonly laneConfigs: readonly string[];

  /** `laneConfigs`: further configs (the lanes', paths inside a package) that also make a directory a package. */
  constructor(laneConfigs: readonly string[] = []) {
    this.laneConfigs = laneConfigs;
  }

  /** Nearest ancestor holding `pnpm-workspace.yaml` or `.git`, else `start` itself. */
  repoRoot(start: string): string {
    let dir = path.resolve(start);
    for (;;) {
      if (existsSync(path.join(dir, 'pnpm-workspace.yaml')) || existsSync(path.join(dir, '.git'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) return path.resolve(start);
      dir = parent;
    }
  }

  /**
   * Nearest ancestor of `absFile`, inside `repoRoot`, with a package.json and a test config:
   * the unit lane's when the package has one, else the first lane config found.
   */
  packageOf(repoRoot: string, absFile: string): Package | undefined {
    let dir = path.dirname(absFile);
    while (isInside(repoRoot, dir)) {
      const pkgJson = path.join(dir, 'package.json');
      if (existsSync(pkgJson)) {
        const testConfig = this.testConfigIn(dir);
        if (testConfig) {
          const name = (JSON.parse(readFileSync(pkgJson, 'utf8')) as { name?: string }).name ?? path.basename(dir);
          return { dir, name, testConfig };
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
    return undefined;
  }

  /** The unit lane's config before any lane's, so a lane config never takes a package the unit lane runs. */
  private testConfigIn(dir: string): string | undefined {
    const first = (names: readonly string[]) => names.map((c) => path.join(dir, c)).find((c) => existsSync(c));
    const pkgJson = path.join(dir, 'package.json');
    return first([...VITEST_CONFIGS, ...JEST_CONFIGS]) ?? (hasJestKey(pkgJson) ? pkgJson : undefined) ?? first([...VITE_CONFIGS, ...this.laneConfigs]);
  }
}

/** Every package of the checkout with `configName` (a path inside it): tracked folders holding both it and a package.json. */
export function packagesWithConfig(repoRoot: string, configName: string): Package[] {
  let tracked: string;
  try {
    tracked = execFileSync('git', ['-c', 'core.quotePath=false', 'ls-files', '--', configName, `*/${configName}`], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    throw new GitError(`${repoRoot} is not a git checkout; the packages of a lane are its tracked folders`);
  }
  return tracked
    .split('\n')
    .filter((f) => f === configName || f.endsWith(`/${configName}`))
    .map((f) => path.join(repoRoot, f.slice(0, -configName.length)))
    .filter((dir) => existsSync(path.join(dir, 'package.json')))
    .toSorted()
    .map((dir) => {
      const name = (JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string }).name ?? path.basename(dir);
      return { dir, name, testConfig: path.join(dir, configName) };
    });
}

/** A `jest` key in a package.json: Jest's config kept there. The locator and the Jest runner share this rule. */
export function hasJestKey(pkgJson: string): boolean {
  try {
    return (JSON.parse(readFileSync(pkgJson, 'utf8')) as { jest?: unknown }).jest !== undefined;
  } catch {
    return false;
  }
}
