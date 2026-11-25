/** Inclusive line range in one file, written `file.ts:12-40`. */
export interface LineRange {
  readonly start: number;
  readonly end: number;
}

export type FileStatus = 'added' | 'modified';

/** A source file in the change. `ranges` is `'whole'` when the file is mutated entirely. */
export interface ChangedFile {
  /** Repo-relative, forward slashes. */
  readonly path: string;
  readonly status: FileStatus;
  readonly ranges: readonly LineRange[] | 'whole';
  /**
   * The text of each hunk's removed lines, one entry per hunk that removed any; `[]` when the change is
   * known to remove nothing. Undefined when unknown (named files, a change list without removedLines,
   * or one that removed lines it does not quote), and then no spec counts as import-only.
   */
  readonly removed?: readonly string[];
  /** Set when lines were removed but their text is not known (a change list); such a spec is always a change. */
  readonly removedUnquoted?: true;
}

export type FileClass = 'logic' | 'component';

export interface TriageDecision {
  readonly file: ChangedFile;
  readonly kept: boolean;
  readonly fileClass: FileClass;
  /** Why the file was dropped; empty when kept. */
  readonly reason: string;
}

/** The specs that constrain one source file. Empty means untested. */
export interface SpecSet {
  readonly file: string;
  readonly specs: readonly string[];
  /** `map` and `command`: a lane's spec mapping or command named them. `coverage`: the lane's coverage map. */
  readonly how: 'explicit' | 'imports' | 'map' | 'command' | 'coverage' | 'none';
}

/** A directory with its own package.json and test config. */
export interface Package {
  /** Absolute path. */
  readonly dir: string;
  readonly name: string;
  /** Absolute path of the package's own vitest (or other runner) config. */
  readonly testConfig: string;
}
