import path from 'node:path';
import type { Package } from '../change/types.ts';
import type { CoverageRunOptions, RunOptions, RunResult, ShimOptions, TestRunner } from '../ports/test-runner.ts';

/** A package's runner cannot do what was asked, such as record a coverage map under Jest. */
export class UnsupportedByRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedByRunnerError';
  }
}

/** Several runners behind one port: each package goes to the first runner that knows its config. */
export class RunnerSet implements TestRunner {
  readonly name: string;
  private readonly runners: readonly TestRunner[];

  constructor(runners: readonly TestRunner[]) {
    this.runners = runners;
    this.name = runners.map((r) => r.name).join(' or ');
  }

  detect(pkg: Package): boolean {
    return this.runners.some((r) => r.detect(pkg));
  }

  writeShim(pkg: Package, opts: ShimOptions, outPath: string): string {
    return this.of(pkg).writeShim(pkg, opts, outPath);
  }

  engineConfig(pkg: Package, shimPath: string): Record<string, unknown> {
    return this.of(pkg).engineConfig(pkg, shimPath);
  }

  run(pkg: Package, shimPath: string, cwd: string, timeoutMs: number, opts?: RunOptions): Promise<RunResult> {
    return this.of(pkg).run(pkg, shimPath, cwd, timeoutMs, opts);
  }

  coverageRefusal(pkg: Package): string | undefined {
    const runner = this.runners.find((r) => r.detect(pkg));
    if (!runner) return `${pkg.name} has ${path.relative(pkg.dir, pkg.testConfig)}, which is not a ${this.name} config`;
    if (runner.recordCoverage) return undefined;
    const able = this.runners.filter((r) => r.recordCoverage).map((r) => r.name);
    return `${pkg.name} runs its tests with ${runner.name}, which cannot record what each spec ran; a coverage map needs a ${able.join(' or ')} package`;
  }

  recordCoverage(pkg: Package, opts: CoverageRunOptions): Promise<{ executed: Map<string, string[]>; result: RunResult }> {
    const refusal = this.coverageRefusal(pkg);
    if (refusal) throw new UnsupportedByRunnerError(refusal);
    return this.of(pkg).recordCoverage!(pkg, opts);
  }

  private of(pkg: Package): TestRunner {
    const runner = this.runners.find((r) => r.detect(pkg));
    if (!runner) throw new Error(`no runner knows ${pkg.testConfig}`);
    return runner;
  }
}
