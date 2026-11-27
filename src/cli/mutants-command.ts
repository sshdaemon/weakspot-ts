import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isInside, repoRelative } from '../change/paths.ts';
import { PLACEHOLDER_SCHEMA_VERSION, type CachedMutant, type PlaceholderFile } from '../mutation/model.ts';
import { runModelJob, type ModelJob, type ModelJobResult } from '../mutation/model-run.ts';
import { MutantsFileError, mutantEntries, validateMutants, type Misfit, type Rejection, type ValidMutant } from '../mutation/validate.ts';
import type { MutantCache } from '../ports/mutant-cache.ts';
import type { PlaceholderFinder } from '../ports/placeholder-finder.ts';
import type { SandboxFactory } from '../ports/sandbox.ts';
import type { SourceInspector } from '../ports/source-inspector.ts';
import type { SuppressionStore } from '../ports/suppression-store.ts';
import type { TestRunner } from '../ports/test-runner.ts';
import { emptyReport, mergeModel } from '../report/merge.ts';
import { renderMarkdown } from '../report/render.ts';
import { survivorId } from '../report/suppressions.ts';
import { survivorsOf } from '../report/survivors.ts';
import { REPORT_SCHEMA_VERSION, type AcceptedMatch, type PackageSummary, type Report } from '../report/types.ts';
import type { ToolConfig } from './config.ts';
import { acceptedEntries, countBy, inspect, InterruptedError, laneOf, noiseOf, runPrepares, UsageError, workerOffsets } from './pipeline.ts';
import { PLACEHOLDERS_FILE } from './propose-command.ts';

export const RECORD_FILE = 'mutants.json';
export const REJECTED_FILE = 'rejected.json';
/** `run --check` output, apart from the run's own record so a check never rewrites what a run reported. */
export const CHECK_REJECTED_FILE = 'check-rejected.json';

export interface MutantsCommandInput {
  readonly placeholders: PlaceholderFile;
  /** Absolute paths of the two input files. */
  readonly placeholdersPath: string;
  readonly mutantsPath: string;
  /** The mutants file's entries, not yet judged. */
  readonly entries: readonly unknown[];
  readonly out: string;
  readonly config: ToolConfig;
  readonly runner: TestRunner;
  readonly sandboxes: SandboxFactory;
  readonly finder: PlaceholderFinder;
  readonly inspector?: SourceInspector;
  readonly suppressions?: { readonly store: SuppressionStore; readonly repoKey: string };
  readonly cache?: { readonly store: MutantCache; readonly repoKey: string };
  readonly log: (line: string) => void;
  readonly commandLine: string;
  readonly version: string;
  readonly signal?: AbortSignal;
}

/** Reads `propose` output; a file of another shape or version is a usage error. */
export function readPlaceholders(file: string): PlaceholderFile {
  const raw = readJson(file);
  const o = raw as Partial<PlaceholderFile>;
  if (o.kind !== 'placeholders' || o.schemaVersion !== PLACEHOLDER_SCHEMA_VERSION || typeof o.repo !== 'string' || !Array.isArray(o.files) || !Array.isArray(o.placeholders)) {
    throw new MutantsFileError(`${file}: not a placeholders file of schema ${PLACEHOLDER_SCHEMA_VERSION}; write one with weakspot propose`);
  }
  return raw as PlaceholderFile;
}

export function readMutantEntries(file: string): unknown[] {
  return mutantEntries(readJson(file), file);
}

function readJson(file: string): unknown {
  if (!existsSync(file)) throw new MutantsFileError(`${file} does not exist`);
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new MutantsFileError(`${file}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
}

function refuseOutInRepo(repoRoot: string, out: string): void {
  if (isInside(repoRoot, out)) throw new UsageError(`--out ${out} is inside the repo ${repoRoot}; the mutant sandboxes must live outside it`);
}

/** The answers judged against the placeholders and the files as they read now, without running anything. */
function judge(input: Pick<MutantsCommandInput, 'placeholders' | 'entries' | 'finder'>): { valid: ValidMutant[]; rejected: Rejection[]; source: (file: string) => string } {
  const source = sourceReader(input.placeholders.repo);
  const misfit: Misfit = (p, replacement) => input.finder.misfit(p.file, source(p.file), p, replacement);
  return { ...validateMutants(input.entries, input.placeholders.placeholders, misfit), source };
}

/**
 * `run --check`: judges the answers as a run would and writes only the rejections, to their own file
 * in `out`, so an author can fix them before the run. Runs no tests and leaves the run's files and the cache alone.
 */
export function checkMutants(input: Pick<MutantsCommandInput, 'placeholders' | 'entries' | 'finder' | 'out'>): { answered: number; cached: number; rejected: readonly Rejection[] } {
  refuseOutInRepo(input.placeholders.repo, input.out);
  const { valid, rejected } = judge(input);
  mkdirSync(input.out, { recursive: true });
  writeFileSync(path.join(input.out, CHECK_REJECTED_FILE), `${JSON.stringify({ rejected }, null, 2)}\n`);
  return { answered: valid.filter((v) => !v.cached).length, cached: valid.filter((v) => v.cached).length, rejected };
}

/**
 * Judges the answers, runs the valid ones in sandboxes per lane and package, and merges the results
 * into the report in `out`. Writes the replayable record and the rejections next to it.
 */
export async function runMutants(input: MutantsCommandInput): Promise<{ report: Report; rejected: readonly Rejection[] }> {
  const { placeholders, out } = input;
  const repoRoot = placeholders.repo;
  refuseOutInRepo(repoRoot, out);
  const { valid, rejected, source } = judge(input);
  input.log(`${valid.length} model mutant(s) to run (${valid.filter((v) => v.cached).length} cached), ${rejected.length} rejected`);

  mkdirSync(out, { recursive: true });
  // Kept even when the run fails below, so answers survive a red dry run and come back as cached.
  input.cache?.store.put(input.cache.repoKey, answeredEntries(valid));

  const jobs = jobsOf(input, valid);
  const prepared = new Set<string>();
  runPrepares(jobs, input.log, prepared);
  const workDir = path.join(out, 'model');
  rmSync(workDir, { recursive: true, force: true });
  const results = await runJobs(jobs, input, workDir, source);
  const mutants = results.flatMap((r) => r.mutants);
  const noise = noiseOf(input, inspect({ repoRoot, ...(input.inspector ? { inspector: input.inspector } : {}) }, mutants));
  const acceptedById = acceptedEntries(input);
  const survivors = survivorsOf(mutants, (m) => noise.get(m.id));
  const accepted: AcceptedMatch[] = [];
  for (const s of survivors) {
    const entry = acceptedById.get(survivorId(s.mutant));
    if (!entry) continue;
    Object.assign(s, { accepted: { reason: entry.reason, date: entry.date } });
    accepted.push({ id: entry.id, where: `${s.mutant.file}:${s.mutant.start.line}:${s.mutant.start.column}`, reason: entry.reason, date: entry.date });
  }
  const packages: PackageSummary[] = jobs.map((job, i) => ({
    lane: job.lane.name,
    escalated: false,
    model: true,
    name: job.pkg.name,
    dir: repoRelative(repoRoot, job.pkg.dir) || '.',
    targets: [...job.files.keys()],
    specs: [...new Set([...job.files.values()].flat())].toSorted(),
    testCount: results[i]!.testCount,
    durationMs: results[i]!.durationMs,
    counts: countBy(results[i]!.mutants),
    artifacts: {},
  }));
  // Written only once every job ran, so the record never lists mutants that did not run.
  const placeholdersCopy = path.join(out, PLACEHOLDERS_FILE);
  if (path.resolve(input.placeholdersPath) !== placeholdersCopy) copyFileSync(input.placeholdersPath, placeholdersCopy);
  const record = path.join(out, RECORD_FILE);
  writeFileSync(record, `${JSON.stringify({ mutants: valid.map(({ placeholder, replacement, because }) => ({ placeholder, replacement, because })) }, null, 2)}\n`);
  writeFileSync(path.join(out, REJECTED_FILE), `${JSON.stringify({ rejected }, null, 2)}\n`);
  const report = mergeModel(baseReport(input), {
    mutants,
    survivors,
    accepted,
    packages,
    summary: { command: input.commandLine, createdAt: new Date().toISOString(), placeholders: placeholdersCopy, mutants: record, rejected },
  });
  writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(path.join(out, 'report.md'), renderMarkdown(report));
  return { report, rejected };
}

/** Files' text in the real tree, each read once per run; a missing file reads as empty, so every placeholder in it is stale. */
function sourceReader(repoRoot: string): (file: string) => string {
  const cache = new Map<string, string>();
  return (file) => {
    const abs = path.join(repoRoot, file);
    if (!cache.has(abs)) cache.set(abs, existsSync(abs) ? readFileSync(abs, 'utf8') : '');
    return cache.get(abs)!;
  };
}

/** The author's valid answers per placeholder; cached ones are already in the cache. */
function answeredEntries(valid: readonly ValidMutant[]): Map<string, CachedMutant[]> {
  const out = new Map<string, CachedMutant[]>();
  for (const v of valid) {
    if (v.cached) continue;
    out.set(v.placeholder, [...(out.get(v.placeholder) ?? []), { replacement: v.replacement, because: v.because }]);
  }
  return out;
}

/** One job per lane and package, with each file's specs as `propose` found them and the lane's current settings. */
function jobsOf(input: MutantsCommandInput, valid: readonly ValidMutant[]): ModelJob[] {
  const repoRoot = input.placeholders.repo;
  const jobs = new Map<string, { lane: ModelJob['lane']; pkg: ModelJob['pkg']; files: Map<string, readonly string[]>; mutants: ValidMutant[] }>();
  for (const v of valid) {
    const target = input.placeholders.files.find((f) => f.path === v.target.file);
    if (!target) throw new MutantsFileError(`${input.placeholdersPath}: placeholder ${v.placeholder} names ${v.target.file}, which has no entry in files`);
    for (const run of target.runs) {
      const laneConfig = input.config.lanes.find((l) => l.name === run.lane);
      if (!laneConfig) throw new UsageError(`${input.placeholdersPath} runs ${v.target.file} in the ${run.lane} lane, which the repo config no longer has; run propose again`);
      const pkg = { name: run.package.name, dir: path.join(repoRoot, run.package.dir), testConfig: path.join(repoRoot, run.package.testConfig) };
      if (!existsSync(pkg.testConfig)) throw new UsageError(`${run.package.testConfig} no longer exists; run propose again`);
      const key = `${run.lane}\0${pkg.dir}`;
      const job = jobs.get(key) ?? { lane: laneOf(laneConfig), pkg, files: new Map<string, readonly string[]>(), mutants: [] };
      job.files.set(v.target.file, run.specs);
      job.mutants.push(v);
      jobs.set(key, job);
    }
  }
  return [...jobs.values()];
}

/** Every job in parallel; the first failure stops the others and is the one rethrown. */
async function runJobs(jobs: readonly ModelJob[], input: MutantsCommandInput, workDir: string, source: (file: string) => string): Promise<ModelJobResult[]> {
  const controller = new AbortController();
  input.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  const offsets = workerOffsets(jobs);
  let cause: unknown;
  const settled = await Promise.allSettled(
    jobs.map((job, i) =>
      runModelJob(job, {
        repoRoot: input.placeholders.repo,
        workDir: path.join(workDir, `${i + 1}-${job.lane.name}`),
        runner: input.runner,
        sandboxes: input.sandboxes,
        workerOffset: offsets[i]!,
        readSource: source,
        log: input.log,
        signal: controller.signal,
      }).catch((err: unknown) => {
        if (!controller.signal.aborted) cause = err;
        controller.abort();
        throw err;
      }),
    ),
  );
  if (input.signal?.aborted) throw new InterruptedError();
  if (settled.some((s) => s.status === 'rejected')) throw cause ?? (settled.find((s) => s.status === 'rejected') as PromiseRejectedResult).reason;
  return settled.map((s) => (s as PromiseFulfilledResult<ModelJobResult>).value);
}

/** The report of an earlier run into the same --out when it is one this run can extend, else an empty one. */
function baseReport(input: MutantsCommandInput): Report {
  const file = path.join(input.out, 'report.json');
  const fresh = emptyReport({ version: input.version, repo: input.placeholders.repo, command: input.placeholders.command, change: input.placeholders.change });
  if (!existsSync(file)) return fresh;
  let raw: Partial<Report>;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Report>;
  } catch {
    input.log(`${file} is not valid JSON; writing a report with the model mutants only`);
    return fresh;
  }
  if (raw.tool !== 'weakspot-ts' || raw.schemaVersion !== REPORT_SCHEMA_VERSION || raw.repo !== input.placeholders.repo) {
    input.log(`${file} is for another repo or report schema; writing a report with the model mutants only`);
    return fresh;
  }
  return raw as Report;
}
