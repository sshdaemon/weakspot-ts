import { createHash } from 'node:crypto';
import type { Mutant } from '../mutation/types.ts';

/** A survivor or untested file a person, or another consumer, decided not to act on, per repository. */
export interface AcceptedEntry {
  readonly repo: string;
  /** A survivor id or `<file>#untested`. */
  readonly id: string;
  readonly reason: string;
  /** ISO date the entry was written. */
  readonly date: string;
}

/**
 * A survivor's id across runs: its file, mutator and a hash of its enclosing function and of the
 * original and replacement text. The line is left out, so an edit elsewhere in the file keeps the id,
 * and so does moving the code within its function; renaming that function changes it. The same change
 * written twice in one function shares an id, and accepting it accepts both.
 */
export function survivorId(m: Mutant): string {
  const hash = createHash('sha1').update(`${m.scope ?? ''}\0${m.original}\0${m.replacement}`).digest('hex').slice(0, 12);
  return `${m.file}#${m.mutator}#${hash}`;
}

export function untestedId(file: string): string {
  return `${file}#untested`;
}

const ID = /^.+#(untested|[A-Za-z]+#[0-9a-f]{12})$/;

/** True for an id `survivorId` or `untestedId` could have produced. */
export function isAcceptableId(id: string): boolean {
  return ID.test(id);
}
