import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isInside } from '../../change/paths.ts';
import type { Package } from '../../change/types.ts';
import type { PackageLocator } from '../../ports/package-locator.ts';

const TEST_CONFIGS = ['vitest', 'vite'].flatMap((n) => ['mts', 'ts', 'cts', 'mjs', 'js', 'cjs'].map((e) => `${n}.config.${e}`));

export class FsPackageLocator implements PackageLocator {
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

  /** Nearest ancestor of `absFile`, inside `repoRoot`, with a package.json and a test config. */
  packageOf(repoRoot: string, absFile: string): Package | undefined {
    let dir = path.dirname(absFile);
    while (isInside(repoRoot, dir)) {
      const pkgJson = path.join(dir, 'package.json');
      if (existsSync(pkgJson)) {
        const testConfig = TEST_CONFIGS.map((c) => path.join(dir, c)).find((c) => existsSync(c));
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
}
