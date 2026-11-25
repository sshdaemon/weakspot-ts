import { copyFileSync, cpSync, existsSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Sandbox, SandboxFactory } from '../../ports/sandbox.ts';

/** The package's own build output and caches, left out at its top level only, so `src/build/` stays. The engine's sandbox leaves out the same. */
export const TOP_LEVEL_BUILD_FOLDERS: readonly string[] = ['dist', 'build', 'coverage', '.turbo'];

/** Left out at any depth, as the engine always does: dependencies (linked instead), git and framework build caches. */
const ANY_DEPTH = new Set(['node_modules', '.git', '.next', '.nuxt', '.svelte-kit']);

/** `fs.cp` of the package without dependencies, build output and caches, with `node_modules` linked back. */
export class CopySandboxFactory implements SandboxFactory {
  create(pkgDir: string, at: string): Sandbox {
    if (existsSync(at)) throw new Error(`sandbox ${at} already exists`);
    cpSync(pkgDir, at, { recursive: true, filter: (src) => copied(path.relative(pkgDir, src)) });
    const modules = path.join(pkgDir, 'node_modules');
    if (existsSync(modules)) symlinkSync(modules, path.join(at, 'node_modules'), 'dir');
    return {
      dir: at,
      write: (file, text) => writeFileSync(path.join(at, file), text),
      restore: (file) => copyFileSync(path.join(pkgDir, file), path.join(at, file)),
      dispose: () => rmSync(at, { recursive: true, force: true }),
    };
  }
}

function copied(rel: string): boolean {
  const parts = rel.split(path.sep);
  if (parts.some((p) => ANY_DEPTH.has(p)) || rel.endsWith('.tsbuildinfo')) return false;
  return !TOP_LEVEL_BUILD_FOLDERS.includes(rel);
}
