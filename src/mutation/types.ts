import type { LineRange, Package } from '../change/types.ts';

/** Statuses as the mutation-testing report schema names them. */
export type MutantStatus =
  | 'Killed'
  | 'Survived'
  | 'NoCoverage'
  | 'Timeout'
  | 'CompileError'
  | 'RuntimeError'
  | 'Ignored'
  | 'Pending';

export interface Position {
  readonly line: number;
  readonly column: number;
}

export interface Mutant {
  readonly id: string;
  /** Repo-relative path. */
  readonly file: string;
  /** Stryker mutator name, or `model` for an authored mutant. */
  readonly mutator: string;
  readonly start: Position;
  readonly end: Position;
  readonly replacement: string;
  readonly status: MutantStatus;
  readonly statusReason: string;
  /** Number of tests that execute the mutant's location in the dry run. */
  readonly coveredBy: number;
  /** Module-level code: no per-test coverage, run against the whole spec set. */
  readonly isStatic: boolean;
  readonly killedBy: readonly string[];
}

export interface Target {
  /** Repo-relative path. */
  readonly file: string;
  readonly ranges: readonly LineRange[] | 'whole';
}

/** Everything one engine run over one package needs. */
export interface PackagePlan {
  readonly pkg: Package;
  readonly targets: readonly Target[];
  /** Repo-relative spec paths; the only tests run. */
  readonly specs: readonly string[];
}

export interface EngineRunResult {
  readonly pkg: Package;
  readonly mutants: readonly Mutant[];
  /** Tests found in the dry run. */
  readonly testCount: number;
  readonly durationMs: number;
  /** Paths of the engine's own artifacts (config, raw report, log). */
  readonly artifacts: Record<string, string>;
}

export interface EngineRunOptions {
  readonly repoRoot: string;
  /** Where the engine may put its temp dir and raw output. Outside the repo. */
  readonly workDir: string;
  readonly timeoutMs: number;
  readonly concurrency: number;
  readonly excludedMutations: readonly string[];
  readonly log: (line: string) => void;
  /** Aborting kills the engine process; set when a sibling package run failed. */
  readonly signal: AbortSignal;
}
