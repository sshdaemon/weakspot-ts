import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isInside } from '../../change/paths.ts';
import type { Package } from '../../change/types.ts';
import type { PackageLocator } from '../../ports/package-locator.ts';
import { GitError } from '../git/git-change-source.ts';

/** The unit lane's config names, tried in this order. */
export const UNIT_TEST_CONFIGS = ['vitest', 'vite'].flatMap((n) => ['mts', 'ts', 'cts', 'mjs', 'js', 'cjs'].map((e) => `${n}.config.${e}`));

export class FsPackageLocator implements PackageLocator {
  private readonly configNames: readonly string[];

  /** `laneConfigs`: further config file names (the lanes') that also make a directory a package. */
  constructor(laneConfigs: readonly string[] = []) {
    this.configNames = [...UNIT_TEST_CONFIGS, ...laneConfigs];
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

  private testConfigIn(dir: string): string | undefined {
    return this.configNames.map((c) => path.join(dir, c)).find((c) => existsSync(c));
  }
}

/** Every package of the checkout with `configName`: tracked folders holding both it and a package.json. */
export function packagesWithConfig(repoRoot: string, configName: string): Package[] {
  let tracked: string;
  try {
    tracked = execFileSync('git', ['-c', 'core.quotePath=false', 'ls-files', '--', configName, `*/${configName}`], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    throw new GitError(`${repoRoot} is not a git checkout; the packages of a lane are its tracked folders`);
  }
  return tracked
    .split('\n')
    .filter((f) => f && path.basename(f) === configName)
    .map((f) => path.join(repoRoot, path.dirname(f)))
    .filter((dir) => existsSync(path.join(dir, 'package.json')))
    .toSorted()
    .map((dir) => {
      const name = (JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string }).name ?? path.basename(dir);
      return { dir, name, testConfig: path.join(dir, configName) };
    });
}
