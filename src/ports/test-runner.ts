import type { Package } from '../change/types.ts';

export interface RunResult {
  readonly passed: number;
  readonly failed: number;
  /** Spec files that failed without a failing test: they did not load, a hook threw, or an error went unhandled. */
  readonly failedFiles: number;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly output: string;
}

export interface ShimOptions {
  /**
   * Directory the runner treats as project root. `'cwd'` means wherever the runner process is
   * started, which is the mutation engine's sandbox copy of the package.
   */
  readonly root: string | 'cwd';
  /** Spec paths relative to `root`. The only tests included. */
  readonly include: readonly string[];
  /** Set in the runner process before the package's config loads; `{worker}` becomes the worker id. */
  readonly env?: Readonly<Record<string, string>>;
  /** The engine's worker id variable; `0` when it is unset, as in a plain run. */
  readonly workerIdVariable?: string;
  /** Added to the engine's worker id, so `{worker}` is unique across every engine process of the run. */
  readonly workerOffset?: number;
}

export interface RunOptions {
  /** Added to the runner process's environment, for example the worker id variable. */
  readonly env?: Readonly<Record<string, string>>;
  /** Aborting kills the runner process. */
  readonly signal?: AbortSignal;
}

/** The test framework behind a package. Vitest today; the seam for Jest and others. */
export interface TestRunner {
  readonly name: string;
  detect(pkg: Package): boolean;
  /** Writes a config that wraps the package's own config and narrows root and include. Returns its path. */
  writeShim(pkg: Package, opts: ShimOptions, outPath: string): string;
  /** The `testRunner` and plugin options for the mutation engine. */
  engineConfig(shimPath: string): Record<string, unknown>;
  /** Runs the specs the shim includes once via the runner's CLI, in `cwd`. */
  run(pkg: Package, shimPath: string, cwd: string, timeoutMs: number, opts?: RunOptions): Promise<RunResult>;
}
