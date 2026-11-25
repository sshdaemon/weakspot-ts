import type { Mutant } from '../mutation/types.ts';
import { findingsOf } from './survivors.ts';
import { REPORT_SCHEMA_VERSION, type AcceptedMatch, type ChangeSummary, type ModelSummary, type PackageSummary, type Report, type Survivor } from './types.ts';

/** What one `run --mutants` produced, ready to merge. */
export interface ModelOutcome {
  readonly mutants: readonly Mutant[];
  readonly survivors: readonly Survivor[];
  readonly accepted: readonly AcceptedMatch[];
  readonly packages: readonly PackageSummary[];
  readonly summary: ModelSummary;
}

const isModel = (m: Pick<Mutant, 'mutator'>): boolean => m.mutator === 'model';

/**
 * The report with the previous model results swapped for these. Operator mutants, untested files and
 * everything else the first run found stay as they were; model findings follow theirs.
 */
export function mergeModel(base: Report, outcome: ModelOutcome): Report {
  return {
    ...base,
    packages: [...base.packages.filter((p) => !p.model), ...outcome.packages],
    mutants: [...base.mutants.filter((m) => !isModel(m)), ...outcome.mutants],
    survivors: [...base.survivors.filter((s) => !isModel(s.mutant)), ...outcome.survivors],
    accepted: [...base.accepted.filter((a) => !a.id.includes('#model#')), ...outcome.accepted],
    findings: [...base.findings.filter((f) => !f.mutant || !isModel(f.mutant)), ...findingsOf(outcome.survivors)],
    model: outcome.summary,
  };
}

/** A report with nothing in it but what the placeholders file says, for a `run --mutants` with no earlier run in its --out. */
export function emptyReport(fields: { version: string; repo: string; command: string; change: ChangeSummary }): Report {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: 'weakspot-ts',
    version: fields.version,
    createdAt: new Date().toISOString(),
    repo: fields.repo,
    command: fields.command,
    change: fields.change,
    packages: [],
    dropped: [],
    untested: [],
    viaChangedSpec: [],
    importOnlySpecs: [],
    viaFallback: [],
    noTestConfig: [],
    warnings: [],
    mutants: [],
    survivors: [],
    killedLater: [],
    accepted: [],
    findings: [],
  };
}
