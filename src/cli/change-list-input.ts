import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { ChangeListError, parseChangeList, type ChangeList } from '../change/change-list.ts';
import { UsageError } from './pipeline.ts';

/** Reads and parses a change list file; a file that cannot be read or is not JSON is a ChangeListError. */
export function readChangeList(file: string): ChangeList {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.resolve(file), 'utf8'));
  } catch (err) {
    throw new ChangeListError(`${file}: cannot read a JSON change list (${err instanceof Error ? err.message : String(err)})`);
  }
  return parseChangeList(raw, file);
}

/** `--repo`, else the change list's repo, else `found()`; with both, they must be the same directory. */
export function repoRootOf(repoFlag: string | undefined, list: ChangeList | undefined, found: () => string): string {
  const given = repoFlag ? path.resolve(repoFlag) : undefined;
  if (list && given && realpathOr(given) !== realpathOr(list.repo)) throw new UsageError(`the change list is for ${list.repo}, but --repo is ${given}`);
  return given ?? list?.repo ?? found();
}

/** A listed file that does not exist is an error, as for named files: a stale list must not turn into untested findings. */
export function checkListedFilesExist(repoRoot: string, list: ChangeList, file: string): void {
  const missing = list.files.map((f) => f.path).filter((p) => !existsSync(path.join(repoRoot, p)));
  if (missing.length > 0) throw new ChangeListError(`${file}: listed files do not exist in ${repoRoot}: ${missing.join(', ')}`);
}

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
