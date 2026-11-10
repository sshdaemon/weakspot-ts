import type { EngineRunOptions, EngineRunResult, PackagePlan } from '../mutation/types.ts';
import type { TestRunner } from './test-runner.ts';

/** Instruments, generates operator mutants and runs them with per-test coverage. StrykerJS today. */
export interface MutationEngine {
  readonly name: string;
  run(plan: PackagePlan, runner: TestRunner, opts: EngineRunOptions): Promise<EngineRunResult>;
}
