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
  /** `map` and `command`: a lane's spec mapping or command named them. */
  readonly how: 'explicit' | 'imports' | 'map' | 'command' | 'none';
}

/** A directory with its own package.json and test config. */
export interface Package {
  /** Absolute path. */
  readonly dir: string;
  readonly name: string;
  /** Absolute path of the package's own vitest (or other runner) config. */
  readonly testConfig: string;
}
