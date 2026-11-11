import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runPrepare } from '../adapters/shell/run-command.ts';
import { isInside, repoRelative } from '../change/paths.ts';
import { applyChangedSpecRule } from '../change/changed-spec.ts';
import { triage } from '../change/triage.ts';
import type { ChangedFile, Package, SpecSet, TriageDecision } from '../change/types.ts';
import { assignLanes, type LaneLookup, type LaneSelection } from '../mutation/lanes.ts';
import { planPackages } from '../mutation/plan.ts';
import type { EngineRunResult, Lane, Mutant, PackagePlan } from '../mutation/types.ts';
import type { MutationEngine } from '../ports/mutation-engine.ts';
import type { PackageLocator } from '../ports/package-locator.ts';
import type { ImportsReader, SpecFinder } from '../ports/spec-finder.ts';
import type { TestRunner } from '../ports/test-runner.ts';
import { renderMarkdown } from '../report/render.ts';
import { findingsOf, survivorsOf, uninstrumentedFiles, untestedFindings } from '../report/survivors.ts';
import type { ChangeSummary, PackageSummary, Report } from '../report/types.ts';
import { UNIT_LANE, type LaneConfig, type ToolConfig } from './config.ts';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** A configured lane after the unit lane, with the finder built from its spec sources. */
export interface PipelineLane {
  readonly config: LaneConfig;
  readonly finder: SpecFinder;
}

export interface PipelineInput {
  readonly changed: readonly ChangedFile[];
  readonly change: ChangeSummary;
  /** Repo-relative spec paths that apply to every kept file in the unit lane; empty for discovery. */
  readonly specs: readonly string[];
  readonly repoRoot: string;
  readonly out: string;
  readonly config: ToolConfig;
  readonly runner: TestRunner;
  readonly engine: MutationEngine;
  /** The unit lane's finder. */
  readonly specFinder: SpecFinder;
  readonly imports?: ImportsReader;
  /** Lanes after the unit lane, in fallback order. */
  readonly lanes?: readonly PipelineLane[];
  readonly laneSelection?: LaneSelection;
  readonly packages: PackageLocator;
  readonly log: (line: string) => void;
  readonly commandLine: string;
  readonly version: string;
  readonly signal?: AbortSignal;
}

/** Triage, spec discovery, the changed-spec rule, one engine run per package, the report. Shared by `files` and `diff`. */
export async function runPipeline(input: PipelineInput): Promise<{ report: Report; outDir: string }> {
  const { repoRoot } = input;
  if (isInside(repoRoot, input.out)) throw new UsageError(`--out ${input.out} is inside the repo ${repoRoot}; reports and the engine's sandbox must live outside it`);

  const decisions = triage(input.changed, input.config.skip, input.config);
  const kept: TriageDecision[] = decisions.filter((d) => d.kept);
  const extraLanes = input.lanes ?? [];
  const laneConfigNames = new Set(extraLanes.map((l) => l.config.config!));
  const unitConfig = input.config.lanes.find((l) => l.name === UNIT_LANE) ?? input.config.lanes[0]!;

  const packages = new Map<string, Package | undefined>();
  const packageOf = (file: string): Package | undefined => {
    if (!packages.has(file)) packages.set(file, input.packages.packageOf(repoRoot, path.join(repoRoot, file)));
    return packages.get(file);
  };
  // The locator answers with the unit config when the package has one, else a lane's; the unit lane wants only the former.
  const unitPackageOf = (file: string): Package | undefined => {
    const pkg = packageOf(file);
    if (!pkg || laneConfigNames.has(path.basename(pkg.testConfig))) return undefined;
    if (!input.runner.detect(pkg)) {
      input.log(`${file}: ${repoRelative(repoRoot, pkg.testConfig)} is not a ${input.runner.name} config`);
      return undefined;
    }
    return pkg;
  };
  const lanePackageOf = (lane: LaneConfig, file: string): Package | undefined => {
    const pkg = packageOf(file);
    if (!pkg) return undefined;
    const testConfig = path.join(pkg.dir, lane.config!);
    if (!existsSync(testConfig)) return undefined;
    const laned = { ...pkg, testConfig };
    if (!input.runner.detect(laned)) {
      input.log(`${file}: ${repoRelative(repoRoot, testConfig)} is not a ${input.runner.name} config`);
      return undefined;
    }
    return laned;
  };

  const unitPackages = new Map<string, Package | undefined>();
  const unitSpecs = new Map<string, SpecSet>();
  for (const d of kept) {
    const pkg = unitPackageOf(d.file.path);
    unitPackages.set(d.file.path, pkg);
    unitSpecs.set(d.file.path, pkg ? input.specFinder.find(repoRoot, pkg, d.file.path, input.specs) : { file: d.file.path, specs: [], how: 'none' });
  }

  // The changed-spec rule checks a changed unit spec, so its files belong to the unit lane alone.
  const selection = input.laneSelection ?? 'fallback';
  const unitSelected = selection === 'fallback' || selection === 'all' || selection.includes(UNIT_LANE);
  const rule = input.imports && unitSelected
    ? applyChangedSpecRule({
        repoRoot,
        changed: input.changed,
        kept,
        specs: unitSpecs,
        packages: unitPackages,
        skip: input.config.skip,
        patterns: input.config,
        importsOf: (spec) => {
          const pkg = unitPackageOf(spec.path);
          return pkg ? { pkg, imports: input.imports!.importsOf(repoRoot, pkg, path.join(repoRoot, spec.path)) } : undefined;
        },
      })
    : { kept, specs: unitSpecs, packages: unitPackages, viaChangedSpec: [] as string[] };
  const viaSpec = rule.viaChangedSpec;
  const ruleAdded = new Set(viaSpec);

  const lookups: LaneLookup[] = [
    {
      lane: laneOf(unitConfig),
      packageOf: (file) => rule.packages.get(file),
      find: (_pkg, file) => rule.specs.get(file) ?? { file, specs: [], how: 'none' },
    },
    ...extraLanes.map((l) => ({
      lane: laneOf(l.config),
      packageOf: (file: string) => (ruleAdded.has(file) ? undefined : lanePackageOf(l.config, file)),
      find: (pkg: Package, file: string) => l.finder.find(repoRoot, pkg, file, []),
    })),
  ];
  const lanes = assignLanes(rule.kept, lookups, selection);
  const { untested, noTestConfig, viaFallback, selected } = lanes;
  const plans: PackagePlan[] = lanes.assignments.flatMap((a) => planPackages(a.kept, a.specs, a.packages, a.lane).plans);
  for (const plan of plans) {
    for (const spec of plan.specs) {
      if (!isInside(plan.pkg.dir, path.join(repoRoot, spec))) {
        throw new UsageError(`spec ${spec} is outside package ${repoRelative(repoRoot, plan.pkg.dir) || '.'}; only files under the package are run`);
      }
    }
  }

  const unitRan = selected.includes(UNIT_LANE);
  for (const f of untested) input.log(`untested: ${f} (no spec found in ${selected.length > 1 ? 'any lane' : `the ${selected[0]} lane`}${unitRan ? '; pass --specs to name one' : ''})`);
  for (const f of noTestConfig) input.log(`no test config: ${f}`);
  for (const f of viaSpec) input.log(`${f}: mutated whole because a spec that imports it changed`);
  for (const { file, lane } of viaFallback) {
    input.log(`${file}: no unit spec, checked by the ${lane} lane${input.specs.length > 0 ? ' (--specs ignored: its package has no unit config)' : ''}`);
  }
  for (const p of plans) input.log(`${p.lane.name} ${p.pkg.name}: ${p.targets.length} file(s), ${p.specs.length} spec(s)`);

  const prepared = new Set<string>();
  for (const p of plans) {
    const key = `${p.lane.name}:${p.pkg.dir}`;
    if (!p.lane.prepare || prepared.has(key)) continue;
    prepared.add(key);
    input.log(`${p.lane.name} ${p.pkg.name}: prepare: ${p.lane.prepare}`);
    runPrepare(p.lane.prepare, p.pkg.dir);
  }

  mkdirSync(input.out, { recursive: true });
  const results = await runAll(plans, input);

  const mutants: Mutant[] = results.flatMap((r) => r.mutants);
  const broken = uninstrumentedFiles(mutants);
  if (broken.length > 0) {
    throw new Error(
      `the specs never loaded the instrumented copy of: ${broken.join(', ')}. ` +
        `Every mutant survived with no covering test, which points at an import or alias that resolves outside the sandbox.`,
    );
  }
  const warnings: string[] = [];
  for (const plan of plans) {
    for (const t of plan.targets) {
      if (!mutants.some((m) => m.file === t.file)) warnings.push(`${t.file}: produced no mutants (nothing mutable in the given range, or the path did not match)`);
    }
  }
  const survivors = survivorsOf(mutants);
  const untestedRanges = new Map(untested.map((f) => [f, input.changed.find((c) => c.path === f)?.ranges ?? 'whole'] as const));
  const packagesOut: PackageSummary[] = results.map((r, i) => ({
    lane: plans[i]!.lane.name,
    name: r.pkg.name,
    dir: repoRelative(repoRoot, r.pkg.dir) || '.',
    targets: plans[i]!.targets.map((t) => t.file),
    specs: plans[i]!.specs,
    testCount: r.testCount,
    durationMs: r.durationMs,
    counts: countBy(r.mutants),
    artifacts: r.artifacts,
  }));
  const report: Report = {
    tool: 'weakspot-ts',
    version: input.version,
    createdAt: new Date().toISOString(),
    repo: repoRoot,
    command: input.commandLine,
    change: input.change,
    packages: packagesOut,
    dropped: decisions.filter((d) => !d.kept).map((d) => ({ path: d.file.path, reason: d.reason })),
    untested,
    viaChangedSpec: viaSpec,
    viaFallback,
    noTestConfig,
    warnings,
    mutants,
    survivors,
    findings: [...untestedFindings(untestedRanges, (f) => lanes.tried.get(f) ?? selected), ...findingsOf(survivors)],
  };
  writeFileSync(path.join(input.out, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(path.join(input.out, 'report.md'), renderMarkdown(report));
  return { report, outDir: input.out };
}

/** Resolves and checks user-given paths: must exist and lie inside the repo. Returns repo-relative paths. */
export function resolveInsideRepo(repoRoot: string, baseDir: string, given: readonly string[], what: string): string[] {
  return given.map((g) => {
    const abs = path.resolve(baseDir, g);
    if (!existsSync(abs)) throw new UsageError(`no such ${what}: ${abs}`);
    if (!isInside(repoRoot, abs)) throw new UsageError(`${abs} is outside the repo root ${repoRoot}`);
    return repoRelative(repoRoot, abs);
  });
}

/** Runs every package in parallel; the first failure aborts the others and is the one rethrown. */
async function runAll(plans: readonly PackagePlan[], input: PipelineInput): Promise<EngineRunResult[]> {
  const controller = new AbortController();
  input.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  let cause: unknown;
  // Every engine process numbers its workers from 0, so each plan gets its own stretch of ids for `{worker}`.
  const offsets = workerOffsets(plans);
  const settled = await Promise.allSettled(
    plans.map((plan, i) =>
      input.engine
        .run(plan, input.runner, {
          repoRoot: input.repoRoot,
          workDir: path.join(input.out, 'engine'),
          excludedMutations: input.config.excludedMutations,
          workerOffset: offsets[i]!,
          log: input.log,
          signal: controller.signal,
        })
        .catch((err: unknown) => {
          if (!controller.signal.aborted) cause = err;
          controller.abort();
          throw err;
        }),
    ),
  );
  if (input.signal?.aborted) throw new Error('interrupted');
  if (settled.some((s) => s.status === 'rejected')) throw cause ?? (settled.find((s) => s.status === 'rejected') as PromiseRejectedResult).reason;
  return settled.map((s) => (s as PromiseFulfilledResult<EngineRunResult>).value);
}

/** Offsets with room for restarts: an engine replaces a crashed worker with a fresh id, so each plan's stretch is far wider than its concurrency. */
export function workerOffsets(plans: readonly PackagePlan[]): number[] {
  const out: number[] = [];
  let next = 0;
  for (const p of plans) {
    out.push(next);
    next += Math.max(100, p.lane.concurrency * 10);
  }
  return out;
}

function laneOf(c: LaneConfig): Lane {
  return { name: c.name, timeoutMs: c.timeoutMs, concurrency: c.concurrency, env: c.envPerWorker, ...(c.prepare ? { prepare: c.prepare } : {}) };
}

function countBy(mutants: readonly Mutant[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of mutants) out[m.status] = (out[m.status] ?? 0) + 1;
  return out;
}
