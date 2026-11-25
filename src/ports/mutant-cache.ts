import type { CachedMutant } from '../mutation/model.ts';

/** Model mutants that passed validation, by placeholder id, per repository; `propose` offers them again. */
export interface MutantCache {
  get(repo: string, placeholder: string): readonly CachedMutant[] | undefined;
  /** Replaces the entries of the given placeholders. */
  put(repo: string, entries: ReadonlyMap<string, readonly CachedMutant[]>): void;
}
