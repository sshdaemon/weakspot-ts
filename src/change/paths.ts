import path from 'node:path';

/** Repo-relative path with forward slashes. */
export function repoRelative(repoRoot: string, abs: string): string {
  return path.relative(repoRoot, abs).split(path.sep).join('/');
}

/** True when `abs` is `root` or lies under it. */
export function isInside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
