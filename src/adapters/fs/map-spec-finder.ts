import { globSync } from 'node:fs';
import path from 'node:path';
import { escapeGlob } from '../../change/glob.ts';
import { isInside, repoRelative } from '../../change/paths.ts';
import type { Package, SpecSet } from '../../change/types.ts';
import type { SpecFinder } from '../../ports/spec-finder.ts';

/**
 * A spec mapping: regex-to-glob pairs on the repo-relative path. The first regex that matches
 * fills its glob's `$1`.. groups (escaped, so a `[id]` segment stays literal) and the glob, relative
 * to the repo root, names the specs. Only
 * existing files inside the file's package count. `explicit` is ignored: it belongs to the unit lane.
 */
export class MapSpecFinder implements SpecFinder {
  private readonly pairs: readonly { re: RegExp; glob: string }[];

  constructor(pairs: readonly (readonly [string, string])[]) {
    this.pairs = pairs.map(([re, glob]) => ({ re: new RegExp(re), glob }));
  }

  find(repoRoot: string, pkg: Package, file: string): SpecSet {
    for (const { re, glob } of this.pairs) {
      const m = re.exec(file);
      if (!m) continue;
      const pattern = glob.replace(/\$(\d+)/g, (_, n: string) => escapeGlob(m[Number(n)] ?? ''));
      const specs = globSync(pattern, { cwd: repoRoot })
        .map((p) => path.join(repoRoot, p))
        .filter((abs) => isInside(pkg.dir, abs))
        .map((abs) => repoRelative(repoRoot, abs))
        .sort();
      return { file, specs, how: specs.length > 0 ? 'map' : 'none' };
    }
    return { file, specs: [], how: 'none' };
  }
}
