import { realpathSync } from 'node:fs';
import path from 'node:path';
import { runPrepare } from '../adapters/shell/run-command.ts';
import { COVERAGE_MAP_SCHEMA_VERSION, mapEntries, type CoverageMap } from '../change/coverage-map.ts';
import { isInside, repoRelative } from '../change/paths.ts';
import { isAnySpec, type SpecPatterns } from '../change/spec-kind.ts';
import type { Package } from '../change/types.ts';
import type { CoverageMapStore } from '../ports/coverage-map-store.ts';
import { UnsupportedByRunnerError } from '../adapters/runner-set.ts';
import type { TestRunner } from '../ports/test-runner.ts';
import { repoKeyOf, type LaneConfig, type ToolConfig } from './config.ts';
import { InterruptedError, UsageError } from './pipeline.ts';

/** A lane's suite ran but recorded nothing: the runner crashed, or the coverage hook never loaded. */
export class MapFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MapFailedError';
  }
}

export interface MapCommandInput {
  readonly repoRoot: string;
  /** The repository key the map is stored under, shared by the checkout's worktrees. */
  readonly repoKey: string;
  readonly lane: LaneConfig;
  readonly runner: TestRunner;
  readonly store: CoverageMapStore;
  readonly patterns: SpecPatterns;
  /** The packages with the lane's config. */
  readonly packages: readonly Package[];
  /** HEAD of the checkout, recorded so a later run can tell how old the map is. */
  readonly head: string;
  /** Folder for generated configs and raw records, outside the repo. */
  readonly workDir: string;
  readonly log: (line: string) => void;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

/** A package whose suite recorded no spec, and why; the others still make the map. */
export interface FailedPackage {
  readonly name: string;
  /** Repo-relative folder. */
  readonly dir: string;
  readonly why: string;
}

export interface MapOutcome {
  readonly map: CoverageMap;
  readonly file: string;
  /** Failing tests and spec files across the packages that finished. */
  readonly failing: number;
  readonly failed: readonly FailedPackage[];
}

/**
 * `weakspot map <lane>`: runs the lane's whole suite in every package that has its config, each spec
 * file isolated, and stores which of the repo's source files each spec ran. A failing spec still ran
 * code, so its files count; the failures are only reported. A package whose suite records nothing is
 * named and left out of the map; only when none records anything does the run fail without a map.
 */
export async function mapCommand(input: MapCommandInput): Promise<MapOutcome> {
  const { lane, runner, repoRoot } = input;
  if (input.packages.length === 0) throw new UsageError(`no package in ${repoRoot} has ${lane.config}, the ${lane.name} lane's config`);
  // Before any prepare: a package whose runner cannot record makes the whole map impossible.
  if (!runner.recordCoverage) throw new UnsupportedByRunnerError(`the ${runner.name} runner cannot record what each spec ran, so no coverage map can be made`);
  const refusals = input.packages.flatMap((p) => runner.coverageRefusal?.(p) ?? []);
  if (refusals.length > 0) throw new UnsupportedByRunnerError(refusals.join('; '));
  const record = runner.recordCoverage.bind(runner);
  const executed = new Map<string, string[]>();
  const mapped: Package[] = [];
  const failed: FailedPackage[] = [];
  let failing = 0;
  // Every prepare before the first suite: a failing one stops the map before any long run, losing nothing.
  for (const pkg of lane.prepare ? input.packages : []) {
    input.log(`${lane.name} ${pkg.name}: prepare: ${lane.prepare}`);
    runPrepare(lane.prepare!, pkg.dir);
  }
  for (const pkg of input.packages) {
    input.log(`${lane.name} ${pkg.name}: running the whole suite`);
    // One package at a time: a lane's suites often share outside state, such as a database server.
    // oxlint-disable-next-line no-await-in-loop -- sequential on purpose, see above
    const { executed: found, result } = await record(pkg, { workDir: path.join(input.workDir, repoRelative(repoRoot, pkg.dir) || 'root'), env: lane.envPerWorker, ...(input.signal ? { signal: input.signal } : {}) });
    if (input.signal?.aborted) throw new InterruptedError();
    if (found.size === 0) {
      const why = result.output.trim().split('\n').slice(-6).join('\n') || 'no output';
      input.log(`${lane.name} ${pkg.name}: recorded no spec, left out of the map: ${why}`);
      failed.push({ name: pkg.name, dir: repoRelative(realpathSync(repoRoot), realpathSync(pkg.dir)) || '.', why });
      continue;
    }
    const failedTests = result.failed + result.failedFiles;
    if (failedTests > 0) input.log(`${lane.name} ${pkg.name}: ${failedTests} failing test(s) or spec file(s); what they ran is in the map all the same`);
    failing += failedTests;
    mapped.push(pkg);
    for (const [spec, modules] of found) executed.set(spec, modules);
  }
  if (mapped.length === 0) throw new MapFailedError(`no ${lane.name} suite recorded a spec: ${failed.map((f) => `${f.name}: ${f.why}`).join('; ')}`);
  const specs = mapEntries(executed, realpathSync(repoRoot), (rel) => isAnySpec(rel, input.patterns));
  if (Object.values(specs).every((files) => files.length === 0)) {
    throw new MapFailedError(`the ${lane.name} suites ran ${Object.keys(specs).length} spec(s) but none ran a function of a source file in ${repoRoot}; the runner may not report what each spec ran`);
  }
  const map: CoverageMap = {
    schemaVersion: COVERAGE_MAP_SCHEMA_VERSION,
    repo: input.repoKey,
    lane: lane.name,
    commit: input.head,
    createdAt: (input.now?.() ?? new Date()).toISOString(),
    packages: mapped.map((p) => repoRelative(realpathSync(repoRoot), realpathSync(p.dir)) || '.'),
    specs,
    ...(failed.length > 0 ? { missing: failed.map((f) => f.dir) } : {}),
  };
  return { map, file: input.store.write(map), failing, failed };
}

/** The lane to map, the repository key the map goes under, and where the run's files go; refuses what would make a map no run reads. */
export function planMap(o: { repoRoot: string; remote: string | undefined; config: ToolConfig; laneName: string; out: string | undefined; home: string; now: Date }): { lane: LaneConfig; repoKey: string; workDir: string } {
  const lane = o.config.lanes.find((l) => l.name === o.laneName);
  if (!lane) throw new UsageError(`map: unknown lane ${o.laneName}; configured: ${o.config.lanes.map((l) => l.name).join(', ')}`);
  if (!lane.config || !lane.specs.includes('coverage')) throw new UsageError(`map: the ${o.laneName} lane does not list "coverage" in its specs, so a map would never be read`);
  const repoKey = repoKeyOf(o.repoRoot, o.remote);
  const stamp = o.now.toISOString().replaceAll(/[:.]/g, '-');
  const workDir = o.out ? path.resolve(o.out) : path.join(o.home, 'runs', repoKey, `map-${o.laneName}-${stamp}`);
  if (isInside(o.repoRoot, workDir)) throw new UsageError(`--out ${workDir} is inside the repo ${o.repoRoot}`);
  return { lane, repoKey, workDir };
}

export function mapSummary({ map, file, failing, failed }: MapOutcome): string {
  const sources = new Set(Object.values(map.specs).flat()).size;
  const failingTests = failing > 0 ? `, ${failing} failing` : '';
  const left = failed.length > 0 ? `\nleft out, recorded nothing: ${failed.map((f) => f.name).join(', ')}` : '';
  return `${Object.keys(map.specs).length} spec(s) in ${map.packages.length} package(s) ran ${sources} source file(s)${failingTests}${left}\nmap: ${file}`;
}
