import type { Mutant } from '../mutation/types.ts';
import type { NoiseClass } from '../report/types.ts';

/** What the source says about a mutant's location. */
export interface MutantSite {
  /** Set when the mutant sits where a surviving change is unlikely to matter. */
  readonly noise?: NoiseClass;
  /** The enclosing named functions and classes, outermost first, joined with dots; empty at module level. */
  readonly scope: string;
}

/** Reads source around mutants. TypeScript's parser today. */
export interface SourceInspector {
  /** One entry per given mutant of one file, by mutant id; none when the file cannot be read. */
  inspect(absFile: string, mutants: readonly Mutant[]): Map<string, MutantSite>;
}
