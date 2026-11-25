import { MAX_MUTANTS_PER_PLACEHOLDER, normalized, type AuthoredMutant, type Placeholder } from './model.ts';

/** The mutants file is not the expected shape at all; nothing in it can be judged one by one. */
export class MutantsFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MutantsFileError';
  }
}

/** An answer that will not run, with the reason the author needs to fix it. */
export interface Rejection {
  readonly placeholder: string;
  readonly replacement: string;
  readonly reason: string;
}

/** An answer that passed every check, with its placeholder. `cached` when it came from an earlier run, not this file. */
export interface ValidMutant extends AuthoredMutant {
  readonly target: Placeholder;
  readonly cached: boolean;
}

/** Why the replacement cannot stand in for the placeholder in the current source, or undefined. */
export type Misfit = (placeholder: Placeholder, replacement: string) => string | undefined;

/** `{ "mutants": [...] }`; entries are judged one by one later, so only the container is checked here. */
export function mutantEntries(raw: unknown, source: string): unknown[] {
  const list = raw && typeof raw === 'object' ? (raw as { mutants?: unknown }).mutants : undefined;
  if (!Array.isArray(list)) throw new MutantsFileError(`${source}: expected { "mutants": [{ "placeholder", "replacement", "because" }] }`);
  return list;
}

/**
 * Judges the author's answers, then the cached mutants of every placeholder the author left
 * unanswered. Treats the file as untrusted: shape, known placeholder, a reason, at most three per
 * placeholder, not identical, not a duplicate, and `misfit` for parse, kind and staleness.
 */
export function validateMutants(entries: readonly unknown[], placeholders: readonly Placeholder[], misfit: Misfit): { valid: ValidMutant[]; rejected: Rejection[] } {
  const byId = new Map(placeholders.map((p) => [p.id, p] as const));
  const valid: ValidMutant[] = [];
  const rejected: Rejection[] = [];
  const answered = new Set<string>();
  const judge = (entry: unknown, cached: boolean): void => {
    const shape = shapeOf(entry);
    if (typeof shape === 'string') {
      rejected.push({ placeholder: placeholderOf(entry), replacement: replacementOf(entry), reason: shape });
      return;
    }
    const replacement = shape.replacement.trim();
    const reject = (reason: string): void => {
      rejected.push({ placeholder: shape.placeholder, replacement, reason });
    };
    const target = byId.get(shape.placeholder);
    if (!target) return reject('no such placeholder in the placeholders file');
    if (!cached) answered.add(target.id);
    const reason = sameAsOthers(target, replacement, valid) ?? misfit(target, replacement);
    if (reason) return reject(reason);
    valid.push({ placeholder: target.id, replacement, because: shape.because.trim(), target, cached });
  };
  for (const entry of entries) judge(entry, false);
  for (const p of placeholders) {
    if (answered.has(p.id)) continue;
    for (const c of p.cached ?? []) judge({ placeholder: p.id, ...c }, true);
  }
  return { valid, rejected };
}

function sameAsOthers(target: Placeholder, replacement: string, valid: readonly ValidMutant[]): string | undefined {
  if (normalized(replacement) === normalized(target.original)) return 'identical to the original';
  const siblings = valid.filter((v) => v.placeholder === target.id);
  if (siblings.some((v) => normalized(v.replacement) === normalized(replacement))) return 'duplicate of an earlier answer for this placeholder';
  if (siblings.length >= MAX_MUTANTS_PER_PLACEHOLDER) return `more than ${MAX_MUTANTS_PER_PLACEHOLDER} answers for this placeholder`;
  return undefined;
}

/** The entry when it has the three string fields and a reason, else why not. */
function shapeOf(entry: unknown): AuthoredMutant | string {
  if (!entry || typeof entry !== 'object') return 'not an object';
  const o = entry as Record<string, unknown>;
  const missing = ['placeholder', 'replacement', 'because'].filter((k) => typeof o[k] !== 'string');
  if (missing.length > 0) return `${missing.join(', ')} missing or not a string`;
  if (!(o['because'] as string).trim()) return 'because is empty: say in one line how the behaviour differs';
  return { placeholder: o['placeholder'] as string, replacement: o['replacement'] as string, because: o['because'] as string };
}

function placeholderOf(entry: unknown): string {
  const v = entry && typeof entry === 'object' ? (entry as Record<string, unknown>)['placeholder'] : undefined;
  return typeof v === 'string' ? v : '';
}

function replacementOf(entry: unknown): string {
  const v = entry && typeof entry === 'object' ? (entry as Record<string, unknown>)['replacement'] : undefined;
  return typeof v === 'string' ? v : '';
}
