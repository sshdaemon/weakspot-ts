/** Dependency lockfiles by package manager: a change to one means the installed node_modules no longer match. */
const LOCKFILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb']);

/** The changed paths that are lockfiles, at any depth. */
export function changedLockfiles(paths: readonly string[]): string[] {
  return paths.filter((p) => LOCKFILES.has(p.slice(p.lastIndexOf('/') + 1)));
}
