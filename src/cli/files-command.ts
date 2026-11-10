import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isInside, repoRelative } from '../change/paths.ts';
import { parseFileArg } from '../change/ranges.ts';
import { triage } from '../change/triage.ts';
import type { ChangedFile, Package, SpecSet } from '../change/types.ts';
import { planPackages } from '../mutation/plan.ts';
import type { EngineRunResult, Mutant, PackagePlan } from '../mutation/types.ts';
import type { MutationEngine } from '../ports/mutation-engine.ts';
import type { PackageLocator } from '../ports/package-locator.ts';
import type { SpecFinder } from '../ports/spec-finder.ts';
import type { TestRunner } from '../ports/test-runner.ts';
import { renderMarkdown } from '../report/render.ts';
import { findingsOf, survivorsOf, uninstrumentedFiles } from '../report/survivors.ts';
import type { PackageSummary, Report } from '../report/types.ts';
import type { ToolConfig } from './config.ts';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface FilesCommandInput {
  /** File arguments, `path` or `path:a-b`, relative to `baseDir`. */
  readonly files: readonly string[];
  readonly specs: readonly string[];
  readonly repoRoot: string;
  /** What relative arguments resolve against: `--repo` when given, else the cwd. */
  readonly baseDir: string;
  readonly out: string;
  readonly config: ToolConfig;
  readonly runner: TestRunner;
  readonly engine: MutationEngine;
  readonly specFinder: SpecFinder;
  readonly packages: PackageLocator;
  readonly log: (line: string) => void;
  readonly commandLine: string;
  readonly version: string;
  /** Aborting (Ctrl-C) stops every engine run. */
  readonly signal?: AbortSignal;
}

export async function filesCommand(input: FilesCommandInput): Promise<{ report: Report; outDir: string }> {
  const { repoRoot } = input;
  if (isInside(repoRoot, input.out)) throw new UsageError(`--out ${input.out} is inside the repo ${repoRoot}; reports and the engine's sandbox must live outside it`);
  const changed: ChangedFile[] = input.files.map((arg) => {
    const p = parseFileArg(arg);
    const abs = path.resolve(input.baseDir, p.path);
    if (!existsSync(abs)) throw new UsageError(`no such file: ${abs}`);
    if (!isInside(repoRoot, abs)) throw new UsageError(`${abs} is outside the repo root ${repoRoot}`);
    return { path: repoRelative(repoRoot, abs), status: 'modified', ranges: p.ranges };
  });
  const explicit = input.specs.map((s) => {
    const abs = path.resolve(input.baseDir, s);
    if (!existsSync(abs)) throw new UsageError(`no such spec: ${abs}`);
    if (!isInside(repoRoot, abs)) throw new UsageError(`${abs} is outside the repo root ${repoRoot}`);
    return repoRelative(repoRoot, abs);
  });

  const decisions = triage(changed, input.config.skip);
  const kept = decisions.filter((d) => d.kept);
  const specs = new Map<string, SpecSet>(kept.map((d) => [d.file.path, input.specFinder.find(repoRoot, d.file.path, explicit)]));
  const packages = new Map<string, Package | undefined>();
  for (const d of kept) {
    const pkg = input.packages.packageOf(repoRoot, path.join(repoRoot, d.file.path));
    if (pkg && !input.runner.detect(pkg)) {
      input.log(`${d.file.path}: ${repoRelative(repoRoot, pkg.testConfig)} is not a ${input.runner.name} config`);
      packages.set(d.file.path, undefined);
    } else {
      packages.set(d.file.path, pkg);
    }
  }
  const { plans, untested, noTestConfig } = planPackages(kept, specs, packages);
  // The engine copies one package into its sandbox, so a spec outside it would never be found.
  for (const plan of plans) {
    for (const spec of plan.specs) {
      if (!isInside(plan.pkg.dir, path.join(repoRoot, spec))) {
        throw new UsageError(`spec ${spec} is outside package ${repoRelative(repoRoot, plan.pkg.dir) || '.'}; only files under the package are run`);
      }
    }
  }

  for (const f of untested) input.log(`untested: ${f} (no spec found; pass --specs to name one)`);
  for (const f of noTestConfig) input.log(`no test config: ${f}`);
  for (const p of plans) input.log(`${p.pkg.name}: ${p.targets.length} file(s), ${p.specs.length} spec(s)`);

  mkdirSync(input.out, { recursive: true });
  const results = await runAll(plans, input, repoRoot);

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
    packages: packagesOut,
    dropped: decisions.filter((d) => !d.kept).map((d) => ({ path: d.file.path, reason: d.reason })),
    untested,
    noTestConfig,
    warnings,
    mutants,
    survivors,
    findings: findingsOf(survivors),
  };
  writeFileSync(path.join(input.out, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(path.join(input.out, 'report.md'), renderMarkdown(report));
  return { report, outDir: input.out };
}

/** Runs every package in parallel; the first failure aborts the others and is the one rethrown. */
async function runAll(plans: readonly PackagePlan[], input: FilesCommandInput, repoRoot: string): Promise<EngineRunResult[]> {
  const controller = new AbortController();
  input.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  let cause: unknown;
  const settled = await Promise.allSettled(
    plans.map((plan) =>
      input.engine
        .run(plan, input.runner, {
          repoRoot,
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
