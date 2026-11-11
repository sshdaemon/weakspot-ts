import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isInside, repoRelative } from '../change/paths.ts';
import { applyChangedSpecRule } from '../change/changed-spec.ts';
import { triage } from '../change/triage.ts';
import type { ChangedFile, Package, SpecSet, TriageDecision } from '../change/types.ts';
import { planPackages } from '../mutation/plan.ts';
import type { EngineRunResult, Mutant, PackagePlan } from '../mutation/types.ts';
import type { MutationEngine } from '../ports/mutation-engine.ts';
import type { PackageLocator } from '../ports/package-locator.ts';
import type { ImportsReader, SpecFinder } from '../ports/spec-finder.ts';
import type { TestRunner } from '../ports/test-runner.ts';
import { renderMarkdown } from '../report/render.ts';
import { findingsOf, survivorsOf, uninstrumentedFiles, untestedFindings } from '../report/survivors.ts';
import type { ChangeSummary, PackageSummary, Report } from '../report/types.ts';
import type { ToolConfig } from './config.ts';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface PipelineInput {
  readonly changed: readonly ChangedFile[];
  readonly change: ChangeSummary;
  /** Repo-relative spec paths that apply to every kept file; empty for discovery. */
  readonly specs: readonly string[];
  readonly repoRoot: string;
  readonly out: string;
  readonly config: ToolConfig;
  readonly runner: TestRunner;
  readonly engine: MutationEngine;
  readonly specFinder: SpecFinder;
  readonly imports?: ImportsReader;
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

  const packages = new Map<string, Package | undefined>();
  const packageOf = (file: string): Package | undefined => {
    if (!packages.has(file)) {
      const pkg = input.packages.packageOf(repoRoot, path.join(repoRoot, file));
      if (pkg && !input.runner.detect(pkg)) {
        input.log(`${file}: ${repoRelative(repoRoot, pkg.testConfig)} is not a ${input.runner.name} config`);
        packages.set(file, undefined);
      } else {
        packages.set(file, pkg);
      }
    }
    return packages.get(file);
  };
  const specs = new Map<string, SpecSet>();
  for (const d of kept) {
    const pkg = packageOf(d.file.path);
    specs.set(d.file.path, pkg ? input.specFinder.find(repoRoot, pkg, d.file.path, input.specs) : { file: d.file.path, specs: [], how: 'none' });
  }

  const rule = input.imports
    ? applyChangedSpecRule({
        repoRoot,
        changed: input.changed,
        kept,
        specs,
        packages,
        skip: input.config.skip,
        patterns: input.config,
        importsOf: (spec) => {
          const pkg = packageOf(spec.path);
          return pkg ? { pkg, imports: input.imports!.importsOf(repoRoot, pkg, path.join(repoRoot, spec.path)) } : undefined;
        },
      })
    : { kept, specs, packages, viaChangedSpec: [] as string[] };
  const viaSpec = rule.viaChangedSpec;

  const { plans, untested, noTestConfig } = planPackages(rule.kept, rule.specs, rule.packages);
  for (const plan of plans) {
    for (const spec of plan.specs) {
      if (!isInside(plan.pkg.dir, path.join(repoRoot, spec))) {
        throw new UsageError(`spec ${spec} is outside package ${repoRelative(repoRoot, plan.pkg.dir) || '.'}; only files under the package are run`);
      }
    }
  }

  for (const f of untested) input.log(`untested: ${f} (no spec found; pass --specs to name one)`);
  for (const f of noTestConfig) input.log(`no test config: ${f}`);
  for (const f of viaSpec) input.log(`${f}: mutated whole because a spec that imports it changed`);
  for (const p of plans) input.log(`${p.pkg.name}: ${p.targets.length} file(s), ${p.specs.length} spec(s)`);

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
    noTestConfig,
    warnings,
    mutants,
    survivors,
    findings: [...untestedFindings(untestedRanges), ...findingsOf(survivors)],
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
  const settled = await Promise.allSettled(
    plans.map((plan) =>
      input.engine
        .run(plan, input.runner, {
          repoRoot: input.repoRoot,
          workDir: path.join(input.out, 'engine'),
          timeoutMs: input.config.timeoutMs,
          concurrency: input.config.concurrency,
          excludedMutations: input.config.excludedMutations,
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

function countBy(mutants: readonly Mutant[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of mutants) out[m.status] = (out[m.status] ?? 0) + 1;
  return out;
}
