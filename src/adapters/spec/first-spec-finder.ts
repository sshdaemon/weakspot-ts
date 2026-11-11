import type { Package, SpecSet } from '../../change/types.ts';
import type { SpecFinder } from '../../ports/spec-finder.ts';

/** A lane's spec sources in order: the first finder that yields specs answers. */
export class FirstSpecFinder implements SpecFinder {
  private readonly finders: readonly SpecFinder[];

  constructor(finders: readonly SpecFinder[]) {
    this.finders = finders;
  }

  find(repoRoot: string, pkg: Package, file: string, explicit: readonly string[]): SpecSet {
    for (const finder of this.finders) {
      const set = finder.find(repoRoot, pkg, file, explicit);
      if (set.specs.length > 0) return set;
    }
    return { file, specs: [], how: 'none' };
  }
}
