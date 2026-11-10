import type { Mutant } from '../mutation/types.ts';
import type { Finding, Survivor } from './types.ts';

/** Survived or NoCoverage mutants. The kind follows coverage, not the engine's label. */
export function survivorsOf(mutants: readonly Mutant[]): Survivor[] {
  return mutants
    .filter((m) => m.status === 'Survived' || m.status === 'NoCoverage')
    .map((m) => ({ mutant: m, kind: kindOf(m) }));
}

function kindOf(m: Mutant): Survivor['kind'] {
  if (m.isStatic && m.status === 'Survived') return 'static';
  return m.coveredBy === 0 ? 'noCoverage' : 'weakAssertion';
}

export function findingsOf(survivors: readonly Survivor[]): Finding[] {
  return survivors.map(({ mutant: m, kind }) => ({
    id: m.id,
    severity: 'medium',
    category: 'tests',
    where: `${m.file}:${m.start.line}:${m.start.column}`,
    claim: claimOf(m, kind),
    evidence: `${m.mutator} mutant, status ${m.status}${m.statusReason ? `: ${m.statusReason}` : ''}`,
  }));
}

function claimOf(m: Mutant, kind: Survivor['kind']): string {
  const change = `\`${short(m.replacement)}\``;
  if (kind === 'static') return `${m.file}:${m.start.line} runs at module load; every test ran against ${change} and none fails.`;
  if (kind === 'noCoverage') return `No test executes ${m.file}:${m.start.line}; changing it to ${change} goes unnoticed.`;
  return `${m.coveredBy} test(s) reach ${m.file}:${m.start.line} and none fails when it becomes ${change}.`;
}

/**
 * Every non-static mutant of a file Survived with no covering test: the specs ran but never loaded the
 * instrumented copy (an import or alias that escapes the sandbox). Reporting those as
 * survivors would be a flood of false positives, so the run fails instead. Static mutants never
 * have per-test coverage, so a file whose run mutants are all static is not evidence of this.
 */
export function uninstrumentedFiles(mutants: readonly Mutant[]): string[] {
  const byFile = new Map<string, Mutant[]>();
  for (const m of mutants) byFile.set(m.file, [...(byFile.get(m.file) ?? []), m]);
  const out: string[] = [];
  for (const [file, list] of byFile) {
    const run = list.filter((m) => m.status !== 'Ignored' && !m.isStatic);
    if (run.length > 0 && run.every((m) => m.status === 'Survived' && m.coveredBy === 0)) out.push(file);
  }
  return out;
}

function short(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > 60 ? `${one.slice(0, 57)}...` : one;
}
