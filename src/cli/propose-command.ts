import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isInside, repoRelative } from '../change/paths.ts';
import type { LineRange } from '../change/types.ts';
import { excerptOf, innermostPerLine, onChangedLines, PLACEHOLDER_SCHEMA_VERSION, withIds, type ModelRun, type Placeholder, type PlaceholderFile, type PlaceholderTarget } from '../mutation/model.ts';
import type { MutantCache } from '../ports/mutant-cache.ts';
import type { PlaceholderFinder } from '../ports/placeholder-finder.ts';
import { type PipelineInput, planRun, UsageError } from './pipeline.ts';

export interface ProposeInput extends PipelineInput {
  readonly finder: PlaceholderFinder;
  /** Earlier runs' mutants for `repoKey`; without it no placeholder is marked. */
  readonly cache?: { readonly store: MutantCache; readonly repoKey: string };
  /** The author prompt, copied into the file. */
  readonly instructions: string;
}

export const PLACEHOLDERS_FILE = 'placeholders.json';

const EXAMPLE = {
  mutants: [{ placeholder: 'src/access.ts#condition#0123456789ab', replacement: "user.role !== 'admin'", because: 'only non-admins pass the check, so admins are locked out of the export' }],
};

/**
 * Finds placeholders on the changed lines of every file a lane has specs for, marks the ones an earlier
 * run already has mutants for, and writes `placeholders.json` to `--out`. Runs no tests.
 */
export function propose(input: ProposeInput): { file: PlaceholderFile; path: string } {
  const { repoRoot } = input;
  if (isInside(repoRoot, input.out)) throw new UsageError(`--out ${input.out} is inside the repo ${repoRoot}; the placeholders and the mutant sandboxes must live outside it`);
  const { lanes, rule } = planRun(input);
  // A source mutated whole for a changed spec did not change: its placeholders would not be on a changed line.
  const viaSpec = new Set(rule.viaChangedSpec);
  for (const f of viaSpec) input.log(`${f}: not offered to the author; only its changed spec makes it a target`);
  const byFile = new Map<string, { ranges: readonly LineRange[] | 'whole'; runs: ModelRun[] }>();
  for (const a of lanes.assignments) {
    for (const d of a.kept.filter((k) => !viaSpec.has(k.file.path))) {
      const pkg = a.packages.get(d.file.path);
      const specs = a.specs.get(d.file.path)?.specs ?? [];
      if (!pkg || specs.length === 0) continue;
      const entry = byFile.get(d.file.path) ?? { ranges: d.file.ranges, runs: [] };
      entry.runs.push({ lane: a.lane.name, package: { name: pkg.name, dir: repoRelative(repoRoot, pkg.dir) || '.', testConfig: repoRelative(repoRoot, pkg.testConfig) }, specs });
      byFile.set(d.file.path, entry);
    }
  }
  const files: PlaceholderTarget[] = [];
  const placeholders: Placeholder[] = [];
  for (const [file, { ranges, runs }] of byFile) {
    const text = readFileSync(path.join(repoRoot, file), 'utf8');
    // Repeats are numbered across the whole file, so an occurrence keeps its id whichever lines changed.
    const found = innermostPerLine(withIds(file, input.finder.find(file, text)).filter((p) => onChangedLines(p, ranges)), ranges).map(({ wide: _wide, ...p }) => p);
    if (found.length === 0) {
      input.log(`${file}: no placeholder on the changed lines`);
      continue;
    }
    files.push({ path: file, runs, excerpt: excerptOf(text, found) });
    placeholders.push(...found.map((p) => withCached(p, input.cache)));
  }
  const out: PlaceholderFile = {
    schemaVersion: PLACEHOLDER_SCHEMA_VERSION,
    tool: 'weakspot-ts',
    kind: 'placeholders',
    version: input.version,
    createdAt: new Date().toISOString(),
    repo: repoRoot,
    command: input.commandLine,
    change: input.change,
    instructions: input.instructions,
    answer: { example: EXAMPLE },
    files,
    placeholders,
  };
  mkdirSync(input.out, { recursive: true });
  const target = path.join(input.out, PLACEHOLDERS_FILE);
  writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
  return { file: out, path: target };
}

function withCached(p: Placeholder, cache: ProposeInput['cache']): Placeholder {
  const cached = cache?.store.get(cache.repoKey, p.id);
  return cached && cached.length > 0 ? { ...p, cached } : p;
}

export function proposeSummary(file: PlaceholderFile, target: string): string {
  const cached = file.placeholders.filter((p) => p.cached).length;
  const open = file.placeholders.length - cached;
  return `${file.placeholders.length} placeholder(s) in ${file.files.length} file(s), ${open} to answer, ${cached} with cached mutants\nplaceholders: ${target}`;
}
