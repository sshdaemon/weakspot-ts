import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { escapeGlob } from '../../change/glob.ts';

/** Links to directories under a package dir, relative to it. Stryker copies such a link as a file and the sandbox copy fails. */
export interface DirectoryLinks {
  /** Inside folders git ignores, such as editor and tool folders. */
  readonly ignored: readonly string[];
  /** Tracked, or untracked and not ignored: these may hold code a spec needs. */
  readonly other: readonly string[];
}

/** Folders Stryker never copies, so links inside them need no pattern; top-level ones match the engine's own ignore list. */
const SKIPPED_ANYWHERE = new Set(['node_modules', '.git', '.next', '.nuxt', '.svelte-kit']);
const SKIPPED_AT_TOP = new Set(['dist', 'build', 'coverage', '.turbo']);

export function directoryLinks(dir: string): DirectoryLinks {
  const ignored = new Set<string>();
  for (const entry of gitList(dir, ['--others', '--ignored', '--exclude-standard', '--directory'])) {
    // An untracked folder holding ignored files is listed too, `./` when it is `dir` itself.
    const rel = entry === './' ? '' : entry.replace(/\/$/, '');
    if (!skipped(rel)) collectLinks(dir, rel, ignored);
  }
  // Plain `ls-files` lists tracked files.
  const other = [...gitList(dir, []), ...gitList(dir, ['--others', '--exclude-standard'])].filter((rel) => !skipped(rel) && isDirectoryLink(path.join(dir, rel)));
  return { ignored: [...ignored], other };
}

/** Anchored Stryker ignore patterns for the links. */
export function linkPatterns(links: DirectoryLinks): string[] {
  return [...links.ignored, ...links.other].map((rel) => `/${escapeGlob(rel)}`);
}

function gitList(dir: string, args: string[]): string[] {
  try {
    const out = execFileSync('git', ['ls-files', ...args, '-z'], { cwd: dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

function skipped(rel: string): boolean {
  const parts = rel.split('/');
  return SKIPPED_AT_TOP.has(parts[0]!) || parts.some((p) => SKIPPED_ANYWHERE.has(p));
}

function isDirectoryLink(abs: string): boolean {
  try {
    return lstatSync(abs).isSymbolicLink() && statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

/** Walks `rel`, adding links to directories; entries that vanish or cannot be read mid-walk are skipped. */
function collectLinks(root: string, rel: string, out: Set<string>): void {
  const abs = path.join(root, rel);
  if (isDirectoryLink(abs)) {
    out.add(rel);
    return;
  }
  let names: string[];
  try {
    names = readdirSync(abs);
  } catch {
    // Not a folder, or gone or unreadable mid-walk.
    return;
  }
  for (const name of names) {
    const child = rel ? `${rel}/${name}` : name;
    if (!skipped(child)) collectLinks(root, child, out);
  }
}
