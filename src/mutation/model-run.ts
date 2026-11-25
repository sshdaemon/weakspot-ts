import path from 'node:path';
import type { Package } from '../change/types.ts';
import type { SandboxFactory, Sandbox } from '../ports/sandbox.ts';
import type { RunResult, TestRunner } from '../ports/test-runner.ts';
import { SandboxNotLoadedError, TestsFailBeforeMutationError } from './errors.ts';
import { applyAt } from './model.ts';
import type { Lane, Mutant, MutantStatus } from './types.ts';
import type { ValidMutant } from './validate.ts';

/** The variable each model worker's runner process gets its worker number in. */
export const MODEL_WORKER_VARIABLE = 'WEAKSPOT_WORKER';

/** No limit of its own in the engine either: a dry run takes as long as the specs do, within reason. */
const DRY_RUN_TIMEOUT_MS = 5 * 60_000;

/** One lane over one package: its files with their specs, and the mutants to run there. */
export interface ModelJob {
  readonly lane: Lane;
  readonly pkg: Package;
  /** Repo-relative paths, each with its repo-relative specs. */
  readonly files: ReadonlyMap<string, readonly string[]>;
  readonly mutants: readonly ValidMutant[];
}

export interface ModelJobOptions {
  readonly repoRoot: string;
  /** Empty folder for this job's sandboxes and shims, outside the repo. */
  readonly workDir: string;
  readonly runner: TestRunner;
  readonly sandboxes: SandboxFactory;
  /** Added to each worker's number for `{worker}`, so parallel jobs never share one. */
  readonly workerOffset: number;
  /** A file's text in the real tree. */
  readonly readSource: (file: string) => string;
  readonly log: (line: string) => void;
  readonly signal: AbortSignal;
}

export interface ModelJobResult {
  readonly mutants: readonly Mutant[];
  /** Tests that passed in the dry run. */
  readonly testCount: number;
  readonly durationMs: number;
}

/**
 * A pool of sandboxes, one per worker, each reused across mutants: write the mutated file, run that
 * file's specs, put the file back. A dry run in the first sandbox comes first and sets the time limit.
 */
export async function runModelJob(job: ModelJob, opts: ModelJobOptions): Promise<ModelJobResult> {
  const started = Date.now();
  if (job.mutants.length === 0) return { mutants: [], testCount: 0, durationMs: 0 };
  const workers = Math.max(1, Math.min(job.lane.concurrency, job.mutants.length));
  const sandboxes: Sandbox[] = [];
  try {
    sandboxes.push(opts.sandboxes.create(job.pkg.dir, path.join(opts.workDir, 'w0', 'pkg')));
    const allSpecs = [...new Set([...job.files.values()].flat())].toSorted();
    const dry = await runSpecs(job, opts, sandboxes[0]!, 0, 'dry', allSpecs, DRY_RUN_TIMEOUT_MS);
    if (dry.failed > 0 || dry.failedFiles > 0 || dry.timedOut || dry.passed === 0) {
      throw new TestsFailBeforeMutationError(job.pkg.name, dry.timedOut ? `the ${job.lane.name} lane's specs ran past ${DRY_RUN_TIMEOUT_MS / 1000}s` : lastLines(dry.output));
    }
    if (opts.signal.aborted) return { mutants: [], testCount: dry.passed, durationMs: Date.now() - started };
    const timeoutMs = job.lane.timeoutMs + Math.round(1.5 * dry.durationMs);
    await checkLoaded(job, opts, sandboxes[0]!, timeoutMs);
    for (let i = 1; i < workers; i++) sandboxes.push(opts.sandboxes.create(job.pkg.dir, path.join(opts.workDir, `w${i}`, 'pkg')));
    opts.log(`${job.lane.name} ${job.pkg.name}: ${job.mutants.length} model mutant(s), ${workers} worker(s), ${(timeoutMs / 1000).toFixed(1)}s each at most`);
    const out: Mutant[] = Array.from({ length: job.mutants.length });
    let next = 0;
    // Each worker takes the next mutant when its last one is done, so one sandbox never runs two at once.
    const work = async (worker: number): Promise<void> => {
      if (next >= job.mutants.length || opts.signal.aborted) return;
      const index = next++;
      out[index] = await runOne(job, opts, sandboxes[worker]!, worker, index, timeoutMs);
      return work(worker);
    };
    await Promise.all(sandboxes.map((_, w) => work(w)));
    return { mutants: out.filter(Boolean), testCount: dry.passed, durationMs: Date.now() - started };
  } finally {
    for (const s of sandboxes) s.dispose();
  }
}

/** A module that throws on load, written over each target in turn: its specs must fail, or they never import the sandbox copy. */
const CANARY = "throw new Error('weakspot: this sandbox copy was loaded');\n";

/** One file at a time in the first sandbox, so a spec of one target never sees another's canary. */
async function checkLoaded(job: ModelJob, opts: ModelJobOptions, sandbox: Sandbox, timeoutMs: number): Promise<void> {
  const files = [...new Set(job.mutants.map((m) => m.target.file))];
  const unloaded: string[] = [];
  const check = async (i: number): Promise<void> => {
    const file = files[i];
    if (file === undefined) return;
    const rel = path.relative(job.pkg.dir, path.join(opts.repoRoot, file));
    sandbox.write(rel, CANARY);
    try {
      const result = await runSpecs(job, opts, sandbox, 0, `canary${i}`, job.files.get(file) ?? [], timeoutMs);
      if (statusOf(result).status === 'Survived') unloaded.push(file);
    } finally {
      sandbox.restore(rel);
    }
    return check(i + 1);
  };
  await check(0);
  if (unloaded.length > 0) throw new SandboxNotLoadedError(unloaded);
}

async function runOne(job: ModelJob, opts: ModelJobOptions, sandbox: Sandbox, worker: number, index: number, timeoutMs: number): Promise<Mutant> {
  const m = job.mutants[index]!;
  const { target } = m;
  const rel = path.relative(job.pkg.dir, path.join(opts.repoRoot, target.file));
  sandbox.write(rel, applyAt(opts.readSource(target.file), target.start, target.end, m.replacement));
  let result: RunResult;
  try {
    result = await runSpecs(job, opts, sandbox, worker, `f${[...job.files.keys()].indexOf(target.file)}`, job.files.get(target.file) ?? [], timeoutMs);
  } finally {
    sandbox.restore(rel);
  }
  const { status, reason } = statusOf(result);
  return {
    id: `${target.file}#${job.lane.name}#model-${index + 1}`,
    file: target.file,
    lane: job.lane.name,
    mutator: 'model',
    start: target.start,
    end: target.end,
    original: target.original,
    scope: target.scope,
    replacement: m.replacement,
    because: m.because,
    status,
    statusReason: reason,
    coveredBy: result.passed + result.failed,
    isStatic: false,
    killedBy: [],
  };
}

/** The runner over `specs` in the worker's sandbox, through a shim of its own so parallel runs never share output files. */
function runSpecs(job: ModelJob, opts: ModelJobOptions, sandbox: Sandbox, worker: number, name: string, specs: readonly string[], timeoutMs: number): Promise<RunResult> {
  const shim = opts.runner.writeShim(
    job.pkg,
    {
      root: 'cwd',
      include: specs.map((s) => path.relative(job.pkg.dir, path.join(opts.repoRoot, s)).split(path.sep).join('/')),
      env: job.lane.env,
      workerIdVariable: MODEL_WORKER_VARIABLE,
      workerOffset: opts.workerOffset,
    },
    path.join(opts.workDir, `w${worker}`, `${name}.shim.mts`),
  );
  return opts.runner.run(job.pkg, shim, sandbox.dir, timeoutMs, { env: { [MODEL_WORKER_VARIABLE]: String(worker) }, signal: opts.signal });
}

/** Killed when a test or a spec file fails, a timeout when the run is cut off, survived when tests ran and passed; a run with no tests is an error. */
export function statusOf(r: Pick<RunResult, 'passed' | 'failed' | 'failedFiles' | 'timedOut' | 'output'>): { status: MutantStatus; reason: string } {
  if (r.timedOut) return { status: 'Timeout', reason: '' };
  if (r.failed > 0) return { status: 'Killed', reason: `${r.failed} test(s) failed` };
  if (r.failedFiles > 0) return { status: 'Killed', reason: `${r.failedFiles} spec file(s) failed to load or run` };
  if (r.passed > 0) return { status: 'Survived', reason: '' };
  return { status: 'RuntimeError', reason: lastLines(r.output) || 'no test ran' };
}

function lastLines(output: string): string {
  return output.trim().split('\n').slice(-6).join('\n');
}
