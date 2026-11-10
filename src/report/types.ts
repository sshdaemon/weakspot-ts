import type { Mutant } from '../mutation/types.ts';

/** `static`: module-level code that ran against the whole spec set with no per-test coverage. */
export type SurvivorKind = 'noCoverage' | 'weakAssertion' | 'static';

export interface Survivor {
  readonly mutant: Mutant;
  readonly kind: SurvivorKind;
}

/** A survivor in the shape a review consumer reads. */
export interface Finding {
  readonly id: string;
  readonly severity: 'medium';
  readonly category: 'tests';
  readonly where: string;
  readonly claim: string;
  readonly evidence: string;
}

export interface PackageSummary {
  readonly name: string;
  readonly dir: string;
  readonly targets: readonly string[];
  readonly specs: readonly string[];
  readonly testCount: number;
  readonly durationMs: number;
  readonly counts: Record<string, number>;
  readonly artifacts: Record<string, string>;
}

export interface Report {
  readonly tool: 'weakspot-ts';
  readonly version: string;
  readonly createdAt: string;
  readonly repo: string;
  readonly command: string;
  readonly packages: readonly PackageSummary[];
  readonly dropped: readonly { path: string; reason: string }[];
  readonly untested: readonly string[];
  readonly noTestConfig: readonly string[];
  /** Things that went wrong without stopping the run, such as a target that produced no mutants. */
  readonly warnings: readonly string[];
  readonly mutants: readonly Mutant[];
  readonly survivors: readonly Survivor[];
  readonly findings: readonly Finding[];
}
