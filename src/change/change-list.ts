import type { ChangedFile } from './types.ts';

/** The change list file shared with tangle-ts: the same files and lines for every tool in a review round. */
export interface ChangeList {
  /** Absolute repo root. */
  readonly repo: string;
  readonly base: string;
  /** `working-tree`, or the commit the files and ranges were read from. */
  readonly head: string;
  readonly files: readonly ChangedFile[];
}

export const WORKING_TREE = 'working-tree';

export class ChangeListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChangeListError';
  }
}

/**
 * `{ repo, base, head, files: [{ path, status, oldPath?, ranges: [[start, end], ...] | "whole", removedLines? }] }`.
 * Paths are repo-relative with forward slashes; ranges are inclusive, 1-based, on the new side.
 * `removedLines` says whether the diff removed any line of the file; a file that only lost lines has
 * `ranges: []`. A renamed file is mutated under its new path, and one that neither gained nor lost a
 * line (a pure move) is left out. The list carries no removed text.
 */
export function parseChangeList(raw: unknown, source: string): ChangeList {
  const fail = (what: string): never => {
    throw new ChangeListError(`${source}: ${what}`);
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('expected a JSON object with repo, base, head and files');
  const o = raw as Record<string, unknown>;
  for (const key of ['repo', 'base', 'head']) if (typeof o[key] !== 'string' || !(o[key] as string).trim()) fail(`${key} must be a non-empty string`);
  if (!(o['repo'] as string).startsWith('/')) fail('repo must be an absolute path');
  if (!Array.isArray(o['files'])) fail('files must be an array');
  const files = (o['files'] as unknown[]).map((f, i) => changedFile(f, `files[${i}]`, fail)).filter((f): f is ChangedFile => f !== undefined);
  return { repo: o['repo'] as string, base: o['base'] as string, head: o['head'] as string, files };
}

/** The file to check, or undefined for a pure move. */
function changedFile(raw: unknown, at: string, fail: (what: string) => never): ChangedFile | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${at} must be an object`);
  const f = raw as Record<string, unknown>;
  const path = f['path'];
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.split('/').includes('..') || path.includes('\\')) {
    fail(`${at}.path must be a repo-relative path with forward slashes, got ${JSON.stringify(path)}`);
  }
  const status = f['status'];
  if (status !== 'added' && status !== 'modified' && status !== 'renamed') fail(`${at}.status must be added, modified or renamed, got ${JSON.stringify(status)}`);
  const removedLines = f['removedLines'];
  if (removedLines !== undefined && typeof removedLines !== 'boolean') fail(`${at}.removedLines must be true or false, got ${JSON.stringify(removedLines)}`);
  const base = { path: path as string, status: status === 'added' ? ('added' as const) : ('modified' as const) };
  const removal = removalOf(removedLines as boolean | undefined);
  const ranges = f['ranges'];
  if (ranges === 'whole') return { ...base, ranges: 'whole', ...removal };
  if (!Array.isArray(ranges)) fail(`${at}.ranges must be "whole" or an array of [start, end] pairs`);
  const parsed = (ranges as unknown[]).map((r, j) => {
    const ok = Array.isArray(r) && r.length === 2 && r.every((n) => Number.isInteger(n) && (n as number) >= 1) && (r[0] as number) <= (r[1] as number);
    if (!ok) fail(`${at}.ranges[${j}] must be [start, end] with 1 <= start <= end, got ${JSON.stringify(r)}`);
    return { start: (r as number[])[0]!, end: (r as number[])[1]! };
  });
  if (parsed.length === 0 && removedLines !== true) return undefined;
  return { ...base, ranges: parsed, ...removal };
}

/** `false`: known to remove nothing. `true`: removed lines, text not given. Absent: unknown (an older list). */
function removalOf(removedLines: boolean | undefined): Pick<ChangedFile, 'removed' | 'removedUnquoted'> {
  if (removedLines === false) return { removed: [] };
  if (removedLines === true) return { removedUnquoted: true };
  return {};
}
