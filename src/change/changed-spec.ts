import { triage } from './triage.ts';
import type { ChangedFile, Package, SpecSet, TriageDecision } from './types.ts';
import { isInside, repoRelative } from './paths.ts';
import { isUnitSpec, type SpecPatterns } from './spec-kind.ts';
import path from 'node:path';

export interface ChangedSpecInput {
  readonly repoRoot: string;
  readonly changed: readonly ChangedFile[];
  readonly kept: readonly TriageDecision[];
  readonly specs: ReadonlyMap<string, SpecSet>;
  readonly packages: ReadonlyMap<string, Package | undefined>;
  readonly skip: readonly string[];
  readonly patterns: SpecPatterns;
  /** The package of a changed spec, and the absolute sources it imports (mocked and type-only ones already excluded). */
  readonly importsOf: (spec: ChangedFile) => { pkg: Package; imports: readonly string[] } | undefined;
}

export interface ChangedSpecOutcome {
  readonly kept: TriageDecision[];
  readonly specs: Map<string, SpecSet>;
  readonly packages: Map<string, Package | undefined>;
  /** Sources added by the rule, mutated whole. */
  readonly viaChangedSpec: string[];
}

/**
 * The changed-spec rule: a changed unit spec mutates the sources it imports, whole, with that
 * spec in their spec set. A source already in the change keeps its ranges and gains the spec.
 * Imports outside the spec's package, dropped by triage, or that are specs themselves are ignored.
 */
export function applyChangedSpecRule(input: ChangedSpecInput): ChangedSpecOutcome {
  const kept = [...input.kept];
  const specs = new Map(input.specs);
  const packages = new Map(input.packages);
  const viaChangedSpec: string[] = [];
  for (const spec of input.changed) {
    if (!isUnitSpec(spec.path, input.patterns)) continue;
    const found = input.importsOf(spec);
    if (!found) continue;
    for (const abs of found.imports) {
      if (!isInside(found.pkg.dir, abs)) continue;
      const file = repoRelative(input.repoRoot, abs);
      const [decision] = triage([{ path: file, status: 'modified', ranges: 'whole' }], input.skip, input.patterns);
      if (!decision?.kept) continue;
      const existing = specs.get(file);
      if (existing) {
        if (!existing.specs.includes(spec.path)) {
          specs.set(file, { file, specs: [...existing.specs, spec.path].sort(), how: existing.specs.length === 0 ? 'imports' : existing.how });
        }
        continue;
      }
      kept.push(decision);
      packages.set(file, found.pkg);
      specs.set(file, { file, specs: [spec.path], how: 'imports' });
      viaChangedSpec.push(file);
    }
  }
  return { kept, specs, packages, viaChangedSpec };
}

/** Absolute path of a repo-relative file. */
export function absoluteOf(repoRoot: string, file: string): string {
  return path.join(repoRoot, file);
}
