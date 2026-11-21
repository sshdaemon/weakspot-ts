import type { Mutant, Span } from './types.ts';

/** `untested`: later lanes take only files with no unit spec. The others also retry unit-lane survivors there. */
export type EscalateMode = 'untested' | 'noCoverage' | 'survivors';

export const ESCALATE_MODES: readonly EscalateMode[] = ['untested', 'noCoverage', 'survivors'];

/** The exact spans to retry per file: those of the unit-lane survivors the mode picks, in file order. */
export function escalationTargets(survivors: readonly Mutant[], mode: EscalateMode): Map<string, Span[]> {
  const out = new Map<string, Span[]>();
  if (mode === 'untested') return out;
  for (const m of survivors) {
    if (m.lane !== 'unit') continue;
    if (mode === 'noCoverage' && m.coveredBy > 0) continue;
    const spans = out.get(m.file) ?? [];
    if (!spans.some((s) => samePosition(s.start, m.start) && samePosition(s.end, m.end))) spans.push({ start: m.start, end: m.end });
    out.set(m.file, spans);
  }
  for (const [file, spans] of out) out.set(file, spans.toSorted((a, b) => a.start.line - b.start.line || a.start.column - b.start.column));
  return out;
}

/** The same mutant run in another lane: same file, mutator, span and replacement. */
export function sameMutant(a: Mutant, b: Mutant): boolean {
  return a.file === b.file && a.mutator === b.mutator && a.replacement === b.replacement && samePosition(a.start, b.start) && samePosition(a.end, b.end);
}

function samePosition(a: { line: number; column: number }, b: { line: number; column: number }): boolean {
  return a.line === b.line && a.column === b.column;
}
