import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runPrepare } from '../adapters/shell/run-command.ts';
import { isInside, repoRelative } from '../change/paths.ts';
import { LineRange } from '../change/ranges.ts';
import { applyChangedSpecRule, type ChangedSpecOutcome } from '../change/changed-spec.ts';
import { triage } from '../change/triage.ts';
import type { ChangedFile, Package, SpecSet, TriageDecision } from '../change/types.ts';
import { assignLanes, type LaneLookup, type LaneOutcome, type LaneSelection } from '../mutation/lanes.ts';
import { escalationTargets, sameMutant } from '../mutation/escalation.ts';
import { planPackages } from '../mutation/plan.ts';
import type { EngineRunResult, Lane, Mutant, PackagePlan } from '../mutation/types.ts';
import type { MutationEngine } from '../ports/mutation-engine.ts';
import type { PackageLocator } from '../ports/package-locator.ts';
import type { ImportsReader, SpecFinder } from '../ports/spec-finder.ts';
import type { MutantSite, SourceInspector } from '../ports/source-inspector.ts';
import type { SuppressionStore } from '../ports/suppression-store.ts';
import { survivorId, untestedId, type AcceptedEntry } from '../report/suppressions.ts';
import type { TestRunner } from '../ports/test-runner.ts';
import { renderMarkdown } from '../report/render.ts';
import { findingsOf, survivorsOf, uninstrumentedFiles, untestedFindings } from '../report/survivors.ts';
import type { AcceptedMatch, ChangeSummary, KilledLater, NoiseClass, PackageSummary, Report, Survivor } from '../report/types.ts';
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
  /** Reads survivors' source for their scope and noise class; without it no survivor has either. */
  readonly inspector?: SourceInspector;
  /** Accepted survivors and untested files for `repoKey`; without it nothing is accepted. */
  readonly suppressions?: { readonly store: SuppressionStore; readonly repoKey: string };
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
  const lookups = laneLookups(input, rule, resolve.lane);
  const lanes = assignLanes(rule.kept, lookups, selection);
  const plans: PackagePlan[] = lanes.assignments.flatMap((a) => planPackages(a.kept, a.specs, a.packages, a.lane).plans);
  checkSpecsInsidePackages(plans, repoRoot);
  logPlan(input, lanes, rule, plans);
  const prepared = new Set<string>();
  runPrepares(plans, input.log, prepared);

  mkdirSync(input.out, { recursive: true });
  const results = await runAll(plans, input, 'engine');
  const sites = inspect(input, results.flatMap((r) => r.mutants));
  const mutants: Mutant[] = results.flatMap((r) => r.mutants.map((m) => withScope(m, sites.get(m.id))));
  const noise = noiseOf(input, sites);
  const acceptedById = new Map((input.suppressions?.store.list(input.suppressions.repoKey) ?? []).map((e) => [e.id, e] as const));
  const hidden = (m: Mutant): boolean => noise.has(m.id) || acceptedById.has(survivorId(m));
  const escalation = await escalate(input, mutants.filter((m) => !hidden(m)), lookups, selection, prepared);
  // A unit spec can import a file and call none of it; a later lane that reaches it shows the sandbox is fine.
  const broken = uninstrumentedFiles(mutants).filter((key) => !escalation.mutants.some((m) => m.file === key && (m.coveredBy > 0 || m.status === 'Killed' || m.status === 'Timeout')));
  if (broken.length > 0) {
    throw new Error(
      `the specs never loaded the instrumented copy of: ${broken.join(', ')}. ` +
        `Every mutant survived with no covering test, which points at an import or alias that resolves outside the sandbox.`,
    );
  }
  const report = buildReport(input, { decisions, lanes, viaChangedSpec: rule.viaChangedSpec, importOnly: rule.importOnly, plans, results, mutants, escalation, noise, acceptedById });
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
  if (!imports || !unitSelected) return { kept, specs, packages, viaChangedSpec: [], importOnly: [] };
  return applyChangedSpecRule({
    repoRoot,
    changed: input.changed,
    kept,
    specs,
    packages,
    skip: input.config.skip,
    patterns: input.config,
    importLines: (spec) => imports.importLines(path.join(repoRoot, spec.path)),
    onlyImports: (text) => imports.onlyImports(text),
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

/** Survivors' scope and noise class, read once per file. */
function inspect(input: PipelineInput, mutants: readonly Mutant[]): Map<string, MutantSite> {
  const out = new Map<string, MutantSite>();
  if (!input.inspector) return out;
  const byFile = new Map<string, Mutant[]>();
  for (const m of mutants) {
    if (m.status === 'Survived' || m.status === 'NoCoverage') byFile.set(m.file, [...(byFile.get(m.file) ?? []), m]);
  }
  for (const [file, list] of byFile) {
    for (const [id, site] of input.inspector.inspect(path.join(input.repoRoot, file), list)) out.set(id, site);
  }
  return out;
}

function withScope(m: Mutant, site: MutantSite | undefined): Mutant {
  return site ? { ...m, scope: site.scope } : m;
}

/** Noise labels limited to the classes the config hides. */
function noiseOf(input: PipelineInput, sites: ReadonlyMap<string, MutantSite>): Map<string, NoiseClass> {
  const out = new Map<string, NoiseClass>();
  for (const [id, site] of sites) if (site.noise && input.config.noise.includes(site.noise)) out.set(id, site.noise);
  return out;
}

function checkSpecsInsidePackages(plans: readonly PackagePlan[], repoRoot: string): void {
  for (const plan of plans) {
    const outside = plan.specs.find((spec) => !isInside(plan.pkg.dir, path.join(repoRoot, spec)));
    if (outside) throw new UsageError(`spec ${outside} is outside package ${repoRelative(repoRoot, plan.pkg.dir) || '.'}; only files under the package are run`);
  }
}

function logPlan(input: PipelineInput, lanes: LaneOutcome, rule: ChangedSpecOutcome, plans: readonly PackagePlan[]): void {
  const { selected } = lanes;
  const where = selected.length > 1 ? 'any lane' : `the ${selected[0]} lane`;
  const hint = selected.includes(UNIT_LANE) ? '; pass --specs to name one' : '';
  const ignored = input.specs.length > 0 ? ' (--specs ignored: its package has no unit config)' : '';
  for (const f of lanes.untested) input.log(`untested: ${f} (no spec found in ${where}${hint})`);
  for (const f of lanes.noTestConfig) input.log(`no test config: ${f}`);
  for (const f of rule.viaChangedSpec) input.log(`${f}: mutated whole because a spec that imports it changed`);
  for (const f of rule.importOnly) input.log(`${f}: only its imports changed, so its sources are not mutated for it`);
  for (const { file, lane } of lanes.viaFallback) input.log(`${file}: no unit spec, checked by the ${lane} lane${ignored}`);
  for (const p of plans) input.log(`${p.lane.name} ${p.pkg.name}: ${p.targets.length} file(s), ${p.specs.length} spec(s)`);
}

/** Each lane's prepare command, once per package across the whole run. */
function runPrepares(plans: readonly PackagePlan[], log: (line: string) => void, prepared: Set<string>): void {
  for (const p of plans) {
    const key = `${p.lane.name}:${p.pkg.dir}`;
    if (!p.lane.prepare || prepared.has(key)) continue;
    prepared.add(key);
    log(`${p.lane.name} ${p.pkg.name}: prepare: ${p.lane.prepare}`);
    runPrepare(p.lane.prepare, p.pkg.dir);
  }
}

interface Escalation {
  readonly plans: readonly PackagePlan[];
  readonly results: readonly EngineRunResult[];
  readonly mutants: readonly Mutant[];
}

/**
 * Retries the unit lane's survivors the escalate mode picks, on their lines only, in the first later
 * lane with specs for the file. Only in fallback: with `--lanes` every lane already ran every file.
 * Files the changed-spec rule added never reach a later lane, as in the first batch.
 */
async function escalate(input: PipelineInput, first: readonly Mutant[], lookups: readonly LaneLookup[], selection: LaneSelection, prepared: Set<string>): Promise<Escalation> {
  const none: Escalation = { plans: [], results: [], mutants: [] };
  if (input.config.escalate === 'untested' || selection !== 'fallback' || lookups.length < 2) return none;
  const targets = escalationTargets(first.filter((m) => m.status === 'Survived' || m.status === 'NoCoverage'), input.config.escalate);
  const decisions: TriageDecision[] = [...targets].map(([file, spans]) => ({
    file: { path: file, status: 'modified', ranges: LineRange.merge(spans.map((sp) => LineRange.of(sp.start.line, sp.end.line))) },
    kept: true,
    fileClass: 'logic',
    reason: '',
  }));
  const later = assignLanes(decisions, lookups.slice(1), 'fallback');
  const plans: PackagePlan[] = [];
  for (const p of later.assignments.flatMap((a) => planPackages(a.kept, a.specs, a.packages, a.lane).plans)) {
    plans.push({ ...p, targets: p.targets.map((t) => Object.assign({}, t, { spans: targets.get(t.file)! })) });
  }
  if (plans.length === 0) return none;
  for (const p of plans) {
    const count = p.targets.reduce((n, t) => n + (t.spans?.length ?? 0), 0);
    input.log(`${p.lane.name} ${p.pkg.name}: retrying ${count} unit-lane survivor(s) in ${p.targets.length} file(s), ${p.specs.length} spec(s)`);
  }
  runPrepares(plans, input.log, prepared);
  const results = await runAll(plans, input, 'engine-escalated');
  return { plans, results, mutants: results.flatMap((r) => r.mutants) };
}

interface RunOutcome {
  readonly decisions: readonly TriageDecision[];
  readonly lanes: LaneOutcome;
  readonly viaChangedSpec: readonly string[];
  readonly importOnly: readonly string[];
  readonly plans: readonly PackagePlan[];
  readonly results: readonly EngineRunResult[];
  readonly mutants: readonly Mutant[];
  readonly escalation: Escalation;
  readonly noise: ReadonlyMap<string, NoiseClass>;
  readonly acceptedById: ReadonlyMap<string, AcceptedEntry>;
}

function buildReport(input: PipelineInput, run: RunOutcome): Report {
  const { repoRoot } = input;
  const { lanes, plans, results, mutants } = run;
  const warnings = plans
    .flatMap((plan) => plan.targets)
    .filter((t) => !mutants.some((m) => m.file === t.file))
    .map((t) => `${t.file}: produced no mutants (nothing mutable in the given range, or the path did not match)`);
  const { noise, acceptedById } = run;
  const survivors: Survivor[] = [];
  const killedLater: KilledLater[] = [];
  for (const s of survivorsOf(mutants, (m) => noise.get(m.id))) {
    const retried = run.escalation.mutants.find((e) => sameMutant(e, s.mutant));
    if (retried && (retried.status === 'Killed' || retried.status === 'Timeout')) {
      killedLater.push({ id: survivorId(s.mutant), where: `${s.mutant.file}:${s.mutant.start.line}:${s.mutant.start.column}`, lane: retried.lane });
      continue;
    }
    const entry = acceptedById.get(survivorId(s.mutant));
    if (entry) Object.assign(s, { accepted: { reason: entry.reason, date: entry.date } });
    if (retried) Object.assign(s, { escalated: { lane: retried.lane, status: retried.status, coveredBy: retried.coveredBy } });
    survivors.push(s);
  }
  const accepted: AcceptedMatch[] = [
    ...survivors.flatMap((s) => (s.accepted ? [{ id: survivorId(s.mutant), where: `${s.mutant.file}:${s.mutant.start.line}:${s.mutant.start.column}`, ...s.accepted }] : [])),
    ...lanes.untested.flatMap((f) => {
      const entry = acceptedById.get(untestedId(f));
      return entry ? [{ id: entry.id, where: f, reason: entry.reason, date: entry.date }] : [];
    }),
  ];
  const untestedRanges = new Map(
    lanes.untested.filter((f) => !acceptedById.has(untestedId(f))).map((f) => [f, input.changed.find((c) => c.path === f)?.ranges ?? 'whole'] as const),
  );
  const summary = (r: EngineRunResult, plan: PackagePlan, escalated: boolean): PackageSummary => ({
    lane: plan.lane.name,
    escalated,
    name: r.pkg.name,
    dir: repoRelative(repoRoot, r.pkg.dir) || '.',
    targets: plan.targets.map((t) => t.file),
    specs: plan.specs,
    testCount: r.testCount,
    durationMs: r.durationMs,
    counts: countBy(r.mutants),
    artifacts: r.artifacts,
  });
  const packages = [
    ...results.map((r, i) => summary(r, plans[i]!, false)),
    ...run.escalation.results.map((r, i) => summary(r, run.escalation.plans[i]!, true)),
  ];
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
    importOnlySpecs: run.importOnly,
    viaFallback: lanes.viaFallback,
    noTestConfig: lanes.noTestConfig,
    warnings,
    mutants: [...mutants, ...run.escalation.mutants],
    survivors,
    killedLater,
    accepted,
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

/**
 * Runs every package in parallel; the first failure aborts the others and is the one rethrown.
 * `workDir` is a folder under `out`; escalation uses its own, so a lane's first run keeps its artifacts.
 */
async function runAll(plans: readonly PackagePlan[], input: PipelineInput, workDir: string): Promise<EngineRunResult[]> {
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
          workDir: path.join(input.out, workDir),
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
