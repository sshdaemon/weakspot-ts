import type { ChangedFile } from '../change/types.ts';

export interface ChangeQuery {
  readonly repoRoot: string;
  /** Ref the change is compared to; the merge base with HEAD is used. */
  readonly base: string;
  /** `working`: committed plus staged plus unstaged plus untracked (default). `staged`: committed plus the index. `committed`: commits only. */
  readonly scope: 'working' | 'staged' | 'committed';
}

/** Yields the files and changed line ranges of a change. Local git today; a PR source later. */
export interface ChangeSource {
  changes(query: ChangeQuery): ChangedFile[];
  /** The base to use when none is configured: the remote's default branch, or undefined when unknown. */
  defaultBase(repoRoot: string): string | undefined;
}
