import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runPrepare } from '../adapters/shell/run-command.ts';
import { isInside, repoRelative } from '../change/paths.ts';
import { applyChangedSpecRule, type ChangedSpecOutcome } from '../change/changed-spec.ts';
import { triage } from '../change/triage.ts';
import type { ChangedFile, Package, SpecSet, TriageDecision } from '../change/types.ts';
import { assignLanes, type LaneLookup, type LaneOutcome, type LaneSelection } from '../mutation/lanes.ts';
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

/** Triage, spec discovery per lane, the changed-spec rule, one engine run per package and lane, the report. Shared by `files` and `diff`. */
export async function runPipeline(input: PipelineInput): Promise<{ report: Report; outDir: string }> {
  const { repoRoot } = input;
  if (isInside(repoRoot, input.out)) throw new UsageError(`--out ${input.out} is inside the repo ${repoRoot}; reports and the engine's sandbox must live outside it`);

  const decisions = triage(input.changed, input.config.skip, input.config);
  const kept: TriageDecision[] = decisions.filter((d) => d.kept);
  const resolve = packageResolvers(input);
  const selection = input.laneSelection ?? 'fallback';
  const rule = unitDiscovery(input, kept, selection, resolve.unit);
  const lanes = assignLanes(rule.kept, laneLookups(input, rule, resolve.lane), selection);
  const plans: PackagePlan[] = lanes.assignments.flatMap((a) => planPackages(a.kept, a.specs, a.packages, a.lane).plans);
  checkSpecsInsidePackages(plans, repoRoot);
  logPlan(input, lanes, rule.viaChangedSpec, plans);
  runPrepares(plans, input.log);

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
  const report = buildReport(input, { decisions, lanes, viaChangedSpec: rule.viaChangedSpec, plans, results, mutants });
  writeFileSync(path.join(input.out, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(path.join(input.out, 'report.md'), renderMarkdown(report));
  return { report, outDir: input.out };
}

interface PackageResolvers {
  /** The file's package with its unit config, or undefined when it has none the runner knows. */
  readonly unit: (file: string) => Package | undefined;
  /** The file's package with the lane's config, or undefined when that package lacks it. */
  readonly lane: (lane: LaneConfig, file: string) => Package | undefined;
}

/** The locator answers with the unit config when the package has one, else a lane's; each lane takes only its own. */
function packageResolvers(input: PipelineInput): PackageResolvers {
  const { repoRoot } = input;
  const laneConfigNames = new Set((input.lanes ?? []).map((l) => l.config.config!));
  const cache = new Map<string, Package | undefined>();
  const packageOf = (file: string): Package | undefined => {
    if (!cache.has(file)) cache.set(file, input.packages.packageOf(repoRoot, path.join(repoRoot, file)));
    return cache.get(file);
  };
  const known = (file: string, pkg: Package): Package | undefined => {
    if (input.runner.detect(pkg)) return pkg;
    input.log(`${file}: ${repoRelative(repoRoot, pkg.testConfig)} is not a ${input.runner.name} config`);
    return undefined;
  };
  return {
    unit: (file) => {
      const pkg = packageOf(file);
      return pkg && !laneConfigNames.has(path.basename(pkg.testConfig)) ? known(file, pkg) : undefined;
    },
    lane: (lane, file) => {
      const pkg = packageOf(file);
      const testConfig = pkg && path.join(pkg.dir, lane.config!);
      return pkg && testConfig && existsSync(testConfig) ? known(file, { ...pkg, testConfig }) : undefined;
    },
  };
}

/** The unit lane's spec sets, widened by the changed-spec rule, which checks a changed unit spec and so runs only when the unit lane does. */
function unitDiscovery(input: PipelineInput, kept: TriageDecision[], selection: LaneSelection, unitPackageOf: PackageResolvers['unit']): ChangedSpecOutcome {
  const { repoRoot } = input;
  const packages = new Map<string, Package | undefined>();
  const specs = new Map<string, SpecSet>();
  for (const d of kept) {
    const pkg = unitPackageOf(d.file.path);
    packages.set(d.file.path, pkg);
    specs.set(d.file.path, pkg ? input.specFinder.find(repoRoot, pkg, d.file.path, input.specs) : { file: d.file.path, specs: [], how: 'none' });
  }
  const imports = input.imports;
  const unitSelected = selection === 'fallback' || selection === 'all' || selection.includes(UNIT_LANE);
  if (!imports || !unitSelected) return { kept, specs, packages, viaChangedSpec: [] };
  return applyChangedSpecRule({
    repoRoot,
    changed: input.changed,
    kept,
    specs,
    packages,
    skip: input.config.skip,
    patterns: input.config,
    importsOf: (spec) => {
      const pkg = unitPackageOf(spec.path);
      return pkg ? { pkg, imports: imports.importsOf(repoRoot, pkg, path.join(repoRoot, spec.path)) } : undefined;
    },
  });
}

/** The unit lane answers from discovery; later lanes ask their finders, and never take a file the changed-spec rule added. */
function laneLookups(input: PipelineInput, rule: ChangedSpecOutcome, lanePackageOf: PackageResolvers['lane']): LaneLookup[] {
  const ruleAdded = new Set(rule.viaChangedSpec);
  const unitConfig = input.config.lanes.find((l) => l.name === UNIT_LANE) ?? input.config.lanes[0]!;
  return [
    {
      lane: laneOf(unitConfig),
      packageOf: (file) => rule.packages.get(file),
      find: (_pkg, file) => rule.specs.get(file) ?? { file, specs: [], how: 'none' },
    },
    ...(input.lanes ?? []).map((l) => ({
      lane: laneOf(l.config),
      packageOf: (file: string) => (ruleAdded.has(file) ? undefined : lanePackageOf(l.config, file)),
      find: (pkg: Package, file: string) => l.finder.find(input.repoRoot, pkg, file, []),
    })),
  ];
}

function checkSpecsInsidePackages(plans: readonly PackagePlan[], repoRoot: string): void {
  for (const plan of plans) {
    const outside = plan.specs.find((spec) => !isInside(plan.pkg.dir, path.join(repoRoot, spec)));
    if (outside) throw new UsageError(`spec ${outside} is outside package ${repoRelative(repoRoot, plan.pkg.dir) || '.'}; only files under the package are run`);
  }
}

function logPlan(input: PipelineInput, lanes: LaneOutcome, viaChangedSpec: readonly string[], plans: readonly PackagePlan[]): void {
  const { selected } = lanes;
  const where = selected.length > 1 ? 'any lane' : `the ${selected[0]} lane`;
  const hint = selected.includes(UNIT_LANE) ? '; pass --specs to name one' : '';
  const ignored = input.specs.length > 0 ? ' (--specs ignored: its package has no unit config)' : '';
  for (const f of lanes.untested) input.log(`untested: ${f} (no spec found in ${where}${hint})`);
  for (const f of lanes.noTestConfig) input.log(`no test config: ${f}`);
  for (const f of viaChangedSpec) input.log(`${f}: mutated whole because a spec that imports it changed`);
  for (const { file, lane } of lanes.viaFallback) input.log(`${file}: no unit spec, checked by the ${lane} lane${ignored}`);
  for (const p of plans) input.log(`${p.lane.name} ${p.pkg.name}: ${p.targets.length} file(s), ${p.specs.length} spec(s)`);
}

/** Each lane's prepare command, once per package. */
function runPrepares(plans: readonly PackagePlan[], log: (line: string) => void): void {
  const prepared = new Set<string>();
  for (const p of plans) {
    const key = `${p.lane.name}:${p.pkg.dir}`;
    if (!p.lane.prepare || prepared.has(key)) continue;
    prepared.add(key);
    log(`${p.lane.name} ${p.pkg.name}: prepare: ${p.lane.prepare}`);
    runPrepare(p.lane.prepare, p.pkg.dir);
  }
}

interface RunOutcome {
  readonly decisions: readonly TriageDecision[];
  readonly lanes: LaneOutcome;
  readonly viaChangedSpec: readonly string[];
  readonly plans: readonly PackagePlan[];
  readonly results: readonly EngineRunResult[];
  readonly mutants: readonly Mutant[];
}

function buildReport(input: PipelineInput, run: RunOutcome): Report {
  const { repoRoot } = input;
  const { lanes, plans, results, mutants } = run;
  const warnings = plans
    .flatMap((plan) => plan.targets)
    .filter((t) => !mutants.some((m) => m.file === t.file))
    .map((t) => `${t.file}: produced no mutants (nothing mutable in the given range, or the path did not match)`);
  const survivors = survivorsOf(mutants);
  const untestedRanges = new Map(lanes.untested.map((f) => [f, input.changed.find((c) => c.path === f)?.ranges ?? 'whole'] as const));
  const packages: PackageSummary[] = results.map((r, i) => ({
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
  return {
    tool: 'weakspot-ts',
    version: input.version,
    createdAt: new Date().toISOString(),
    repo: repoRoot,
    command: input.commandLine,
    change: input.change,
    packages,
    dropped: run.decisions.filter((d) => !d.kept).map((d) => ({ path: d.file.path, reason: d.reason })),
    untested: lanes.untested,
    viaChangedSpec: run.viaChangedSpec,
    viaFallback: lanes.viaFallback,
    noTestConfig: lanes.noTestConfig,
    warnings,
    mutants,
    survivors,
    findings: [...untestedFindings(untestedRanges, (f) => lanes.tried.get(f) ?? lanes.selected), ...findingsOf(survivors)],
  };
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
