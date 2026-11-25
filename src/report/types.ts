import type { Mutant, MutantStatus } from '../mutation/types.ts';

/** `static`: module-level code that ran against the whole spec set with no per-test coverage. */
export type SurvivorKind = 'noCoverage' | 'weakAssertion' | 'static';

/**
 * A label for a survivor that is unlikely to matter: inside a logging call, inside the arguments
 * of an error being built, inside a catch block, or inside a JSX attribute.
 */
export type NoiseClass = 'logging' | 'errorMessage' | 'catchOnly' | 'jsxAttribute';

export const NOISE_CLASSES: readonly NoiseClass[] = ['logging', 'errorMessage', 'catchOnly', 'jsxAttribute'];

export interface Survivor {
  readonly mutant: Mutant;
  readonly kind: SurvivorKind;
  /** Set when the survivor falls in a noise class the config hides; such survivors are not findings. */
  readonly noise?: NoiseClass;
  /** Set when the survivor's id was accepted for this repository; such survivors are not findings. */
  readonly accepted?: { readonly reason: string; readonly date: string };
  /** Set when escalation retried it in a later lane and it was not killed there: it survived, or errored. */
  readonly escalated?: { readonly lane: string; readonly status: MutantStatus; readonly coveredBy: number };
}

/** A unit-lane survivor that escalation retried in a later lane, where a test killed it. */
export interface KilledLater {
  readonly id: string;
  readonly where: string;
  readonly lane: string;
}

/** An accepted entry that matched something in this run. */
export interface AcceptedMatch {
  readonly id: string;
  /** `file:line:column` for a survivor, the file for an untested file. */
  readonly where: string;
  readonly reason: string;
  readonly date: string;
}

/**
 * A survivor or an untested file in the shape a consumer reads. Part of the report contract: a
 * change to these fields bumps REPORT_SCHEMA_VERSION.
 */
export interface Finding {
  /** Stable across runs: `<file>#<mutator>#<hash>` for a survivor, `<file>#untested`. Pass it to `weakspot accept`. */
  readonly id: string;
  readonly severity: 'medium';
  readonly category: 'tests';
  /** `untested`: no spec reaches the file; otherwise the survivor kind. */
  readonly kind: 'untested' | SurvivorKind;
  /** Repo-relative path. */
  readonly file: string;
  /** `file:line:column` for a survivor, the file for an untested file. */
  readonly where: string;
  /** One sentence a reviewer can act on. */
  readonly claim: string;
  readonly evidence: string;
  /** Survivor findings only. */
  readonly mutant?: FindingMutant;
}

/** Where a survivor sits and what it changed; line and column are 1-based, end exclusive. */
export interface FindingMutant {
  readonly lane: string;
  readonly mutator: string;
  readonly start: { readonly line: number; readonly column: number };
  readonly end: { readonly line: number; readonly column: number };
  readonly original: string;
  readonly replacement: string;
  /** Tests in the lane that ran the mutant's location. */
  readonly coveredBy: number;
  /** Set when escalation retried it in a later lane, which did not kill it. */
  readonly escalated?: { readonly lane: string; readonly status: MutantStatus; readonly coveredBy: number };
  /** A model mutant's reading of how behaviour differs, from its author. */
  readonly because?: string;
}

/** Additions are compatible; bumped whenever a field of Report or Finding is removed, renamed or changes meaning. */
export const REPORT_SCHEMA_VERSION = 1;

export interface PackageSummary {
  readonly lane: string;
  /** A run that retried unit-lane survivors, not one that took untested files. */
  readonly escalated: boolean;
  /** Set on runs of model mutants, which `run --mutants` replaces as a whole. */
  readonly model?: true;
  readonly name: string;
  readonly dir: string;
  readonly targets: readonly string[];
  readonly specs: readonly string[];
  readonly testCount: number;
  readonly durationMs: number;
  readonly counts: Record<string, number>;
  readonly artifacts: Record<string, string>;
}

/** What the run looked at: named files, or a diff against a base. */
export interface ChangeSummary {
  /** `changes`: a change list file the caller wrote. `pr`: a pull request, checked in a worktree of its own. */
  readonly kind: 'files' | 'diff' | 'changes' | 'pr';
  readonly detail: string;
}

export interface Report {
  readonly schemaVersion: number;
  readonly tool: 'weakspot-ts';
  readonly version: string;
  readonly createdAt: string;
  readonly repo: string;
  readonly command: string;
  readonly change: ChangeSummary;
  readonly packages: readonly PackageSummary[];
  readonly dropped: readonly { path: string; reason: string }[];
  readonly untested: readonly string[];
  /** Sources mutated whole because a spec that imports them changed. */
  readonly viaChangedSpec: readonly string[];
  /** Changed specs whose edit touched only imports, so the changed-spec rule left their sources alone. */
  readonly importOnlySpecs: readonly string[];
  /** Files with no unit spec that a later lane checked. */
  readonly viaFallback: readonly { file: string; lane: string }[];
  readonly noTestConfig: readonly string[];
  /** Things that went wrong without stopping the run, such as a target that produced no mutants. */
  readonly warnings: readonly string[];
  readonly mutants: readonly Mutant[];
  readonly survivors: readonly Survivor[];
  /** Unit-lane survivors a later lane's tests killed; they are not findings. */
  readonly killedLater: readonly KilledLater[];
  /** Accepted survivors and untested files this run met; they are not findings. */
  readonly accepted: readonly AcceptedMatch[];
  readonly findings: readonly Finding[];
  /** Set once `run --mutants` has merged model mutants into the report. */
  readonly model?: ModelSummary;
}

/** The last `run --mutants` merged into the report. */
export interface ModelSummary {
  readonly command: string;
  readonly createdAt: string;
  /** Paths of the placeholders file and the record of the mutants that ran, both replayable. */
  readonly placeholders: string;
  readonly mutants: string;
  /** Answers that did not run, with the reason; also in rejected.json. */
  readonly rejected: readonly { readonly placeholder: string; readonly replacement: string; readonly reason: string }[];
}
