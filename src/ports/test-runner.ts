import type { Package } from '../change/types.ts';

export interface RunResult {
  readonly passed: number;
  readonly failed: number;
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
}

/** The test framework behind a package. Vitest today; the seam for Jest and others. */
export interface TestRunner {
  readonly name: string;
  detect(pkg: Package): boolean;
  /** Writes a config that wraps the package's own config and narrows root and include. Returns its path. */
  writeShim(pkg: Package, opts: ShimOptions, outPath: string): string;
  /** The `testRunner` and plugin options for the mutation engine. */
  engineConfig(shimPath: string): Record<string, unknown>;
  /** Runs the given specs once, without mutation, via the runner's CLI. */
  run(pkg: Package, shimPath: string, cwd: string, timeoutMs: number): Promise<RunResult>;
}
