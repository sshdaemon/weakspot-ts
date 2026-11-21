import type { LineRange } from '../change/types.ts';
import type { Mutant } from '../mutation/types.ts';
import { survivorId, untestedId } from './suppressions.ts';
import type { Finding, NoiseClass, Survivor } from './types.ts';

/** Survived or NoCoverage mutants. The kind follows coverage, not the engine's label; `noiseOf` labels the hidden ones. */
export function survivorsOf(mutants: readonly Mutant[], noiseOf: (m: Mutant) => NoiseClass | undefined = () => undefined): Survivor[] {
  return mutants
    .filter((m) => m.status === 'Survived' || m.status === 'NoCoverage')
    .map((m) => {
      const noise = noiseOf(m);
      return noise ? { mutant: m, kind: kindOf(m), noise } : { mutant: m, kind: kindOf(m) };
    });
}

function kindOf(m: Mutant): Survivor['kind'] {
  if (m.isStatic && m.status === 'Survived') return 'static';
  return m.coveredBy === 0 ? 'noCoverage' : 'weakAssertion';
}

/**
 * One finding per file no lane reaches: the change is unchecked by any test the lanes know.
 * `lanesOf` names the lanes that looked for the file's specs; the evidence says only what ran.
 */
export function untestedFindings(files: ReadonlyMap<string, readonly LineRange[] | 'whole'>, lanesOf: (file: string) => readonly string[] = () => ['unit']): Finding[] {
  return [...files].map(([file, ranges]) => {
    const lanes = lanesOf(file);
    const evidence = [
      ...(lanes.includes('unit') ? ['no unit spec in the package imports the file (a spec that mocks it or imports only its types does not count)'] : []),
      ...lanes.filter((l) => l !== 'unit').map((l) => `the ${l} lane's spec sources name none`),
    ].join('; ');
    const lines = ranges === 'whole' ? 0 : ranges.reduce((n, r) => n + r.end - r.start + 1, 0);
    const scope = ranges === 'whole' ? 'the whole file goes' : changedLines(lines);
    return {
      id: untestedId(file),
      severity: 'medium',
      category: 'tests',
      kind: 'untested',
      file,
      where: file,
      claim: `No spec exercises ${file}; ${scope} unchecked by tests.`,
      evidence,
    };
  });
}

function changedLines(n: number): string {
  return n === 1 ? 'its 1 changed line goes' : `its ${n} changed lines go`;
}

/** Survivors in a hidden noise class, or accepted, are left out. */
export function findingsOf(survivors: readonly Survivor[]): Finding[] {
  return survivors.filter((s) => !s.noise && !s.accepted).map(({ mutant: m, kind, escalated }) => ({
    id: survivorId(m),
    severity: 'medium',
    category: 'tests',
    kind,
    file: m.file,
    where: `${m.file}:${m.start.line}:${m.start.column}`,
    claim: claimOf(m, kind),
    mutant: {
      lane: m.lane,
      mutator: m.mutator,
      start: m.start,
      end: m.end,
      original: m.original,
      replacement: m.replacement,
      coveredBy: m.coveredBy,
      ...(escalated ? { escalated } : {}),
    },
    evidence: `${m.mutator} mutant in the ${m.lane} lane, status ${m.status}${m.statusReason ? `: ${m.statusReason}` : ''}${escalated ? `; ${laterLane(escalated)}` : ''}`,
  }));
}

/** How a retry in a later lane ended, when it did not kill the mutant. */
export function laterLane(e: NonNullable<Survivor['escalated']>): string {
  if (e.status === 'Survived' || e.status === 'NoCoverage') return `also survives in the ${e.lane} lane with ${e.coveredBy} covering test(s)`;
  return `ended as ${e.status} in the ${e.lane} lane, so that lane could not judge it`;
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
  for (const m of mutants) {
    const key = m.lane === 'unit' ? m.file : `${m.file} (${m.lane} lane)`;
    byFile.set(key, [...(byFile.get(key) ?? []), m]);
  }
  const out: string[] = [];
  for (const [file, list] of byFile) {
    const run = list.filter((m) => m.status !== 'Ignored' && !m.isStatic);
    if (run.length > 0 && run.every((m) => m.status === 'Survived' && m.coveredBy === 0)) out.push(file);
  }
  return out;
}

function short(s: string): string {
  const one = s.replaceAll(/\s+/g, ' ').trim();
  return one.length > 60 ? `${one.slice(0, 57)}...` : one;
}
