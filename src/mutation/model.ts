import { createHash } from 'node:crypto';
import type { LineRange } from '../change/types.ts';
import type { ChangeSummary } from '../report/types.ts';
import type { Position } from './types.ts';

/** Where an author may write a mutant: the tool's own kinds, not a parser's node names. */
export type PlaceholderKind = 'condition' | 'loopHeader' | 'callArguments' | 'callee' | 'returnExpression' | 'statement';

/** A fragment found in source, before it has an id. Lines and columns 1-based, end exclusive. */
export interface FoundPlaceholder {
  readonly kind: PlaceholderKind;
  readonly start: Position;
  readonly end: Position;
  readonly original: string;
  /** Enclosing named functions and classes, outermost first, dot-joined. */
  readonly scope: string;
  /** Holds a function or JSX: offered only where nothing smaller sits on a changed line (see `innermostPerLine`). Never written out. */
  readonly wide?: true;
}

export interface Placeholder extends FoundPlaceholder {
  /** `<file>#<kind>#<hash>`, with `~2`, `~3` for later copies of the same fragment in one scope. */
  readonly id: string;
  /** Repo-relative path. */
  readonly file: string;
  /** Mutants an earlier run took for this id; `run --mutants` uses them unless the author answers the placeholder. */
  readonly cached?: readonly CachedMutant[];
}

export interface CachedMutant {
  readonly replacement: string;
  readonly because: string;
}

/** One answer in the author's mutants file. */
export interface AuthoredMutant extends CachedMutant {
  readonly placeholder: string;
}

/** Where one file's mutants run: one entry per lane that found specs for it. */
export interface ModelRun {
  readonly lane: string;
  /** Package name, its directory and its test config for this lane, both repo-relative. */
  readonly package: { readonly name: string; readonly dir: string; readonly testConfig: string };
  /** Repo-relative spec paths. */
  readonly specs: readonly string[];
}

export interface PlaceholderTarget {
  /** Repo-relative path. */
  readonly path: string;
  readonly runs: readonly ModelRun[];
  /** The source around every placeholder of the file, so an author needs nothing else. */
  readonly excerpt: { readonly startLine: number; readonly text: string };
}

/** What `propose` writes: everything an author needs, and everything `run --mutants` needs to replay. */
export interface PlaceholderFile {
  readonly schemaVersion: number;
  readonly tool: 'weakspot-ts';
  readonly kind: 'placeholders';
  readonly version: string;
  readonly createdAt: string;
  /** Absolute repo root. */
  readonly repo: string;
  readonly command: string;
  readonly change: ChangeSummary;
  /** The author prompt. */
  readonly instructions: string;
  /** The shape of the file the author writes, with one filled-in entry. */
  readonly answer: { readonly example: { readonly mutants: readonly AuthoredMutant[] } };
  readonly files: readonly PlaceholderTarget[];
  readonly placeholders: readonly Placeholder[];
}

export const PLACEHOLDER_SCHEMA_VERSION = 1;

/** Answers per placeholder; more are rejected. */
export const MAX_MUTANTS_PER_PLACEHOLDER = 3;

/** Lines of source kept above the first and below the last placeholder of a file. */
export const CONTEXT_LINES = 40;

/**
 * Ids keyed by file, kind, scope and text, not line: an edit elsewhere in the file keeps them, so
 * cached mutants still apply. Repeats of one fragment in one scope are numbered in source order.
 */
export function withIds(file: string, found: readonly FoundPlaceholder[]): Placeholder[] {
  const seen = new Map<string, number>();
  return found.map((p) => {
    const base = `${file}#${p.kind}#${createHash('sha1').update(`${p.scope}\0${p.original}`).digest('hex').slice(0, 12)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { ...p, id: n === 1 ? base : `${base}~${n}`, file };
  });
}

/** True when the placeholder's lines touch a changed range. */
export function onChangedLines(p: Pick<FoundPlaceholder, 'start' | 'end'>, ranges: readonly LineRange[] | 'whole'): boolean {
  if (ranges === 'whole') return true;
  return ranges.some((r) => p.start.line <= r.end && r.start <= p.end.line);
}

/**
 * Drops a wide placeholder (a callback's argument list, a returned JSX tree) when every changed line it
 * touches already has a smaller placeholder, so a one-line change inside a callback is answered on that line.
 */
export function innermostPerLine<T extends FoundPlaceholder>(placeholders: readonly T[], ranges: readonly LineRange[] | 'whole'): T[] {
  const changed = (line: number) => ranges === 'whole' || ranges.some((r) => r.start <= line && line <= r.end);
  const smallerOn = (p: T, line: number) => placeholders.some((q) => q !== p && q.original.length < p.original.length && q.start.line <= line && line <= q.end.line);
  return placeholders.filter((p) => {
    if (!p.wide) return true;
    for (let line = p.start.line; line <= p.end.line; line++) if (changed(line) && !smallerOn(p, line)) return true;
    return false;
  });
}

/** The lines from CONTEXT_LINES above the first placeholder to CONTEXT_LINES below the last. */
export function excerptOf(text: string, placeholders: readonly FoundPlaceholder[]): { startLine: number; text: string } {
  const starts = lineStarts(text);
  const first = Math.min(...placeholders.map((p) => p.start.line));
  const last = Math.max(...placeholders.map((p) => p.end.line));
  const startLine = Math.max(1, first - CONTEXT_LINES);
  const endLine = Math.min(starts.length, last + CONTEXT_LINES);
  return { startLine, text: text.slice(starts[startLine - 1], starts[endLine] ?? text.length).replace(/(\r\n|[\n\r\u2028\u2029])$/, '') };
}

/** Whitespace-insensitive form, for identical and duplicate checks. */
export function normalized(code: string): string {
  return code.replaceAll(/\s+/g, ' ').trim();
}

/** `text` with the span between two positions (1-based, end exclusive) replaced. */
export function applyAt(text: string, start: Position, end: Position, replacement: string): string {
  const starts = lineStarts(text);
  const offset = (p: Position) => (starts[p.line - 1] ?? text.length) + p.column - 1;
  return text.slice(0, offset(start)) + replacement + text.slice(offset(end));
}

/** Offsets where each line starts, breaking lines where TypeScript does (CRLF, LF, CR, U+2028, U+2029), so positions from the parser line up. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\r' && text[i + 1] === '\n') i++;
    if (c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029') starts.push(i + 1);
  }
  return starts;
}
