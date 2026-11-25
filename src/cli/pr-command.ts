import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import type { ChangeSource } from '../ports/change-source.ts';
import type { DependencyLinker } from '../ports/dependency-linker.ts';
import type { PullRequest, PullRequestCheckout, PullRequestSource } from '../ports/pull-request-source.ts';
import type { Report } from '../report/types.ts';
import { isInside, repoRelative } from '../change/paths.ts';
import { type PipelineInput, runPipeline, UsageError } from './pipeline.ts';

export interface PrCommandInput extends Omit<PipelineInput, 'changed' | 'change' | 'specs' | 'repoRoot'> {
  /** The local checkout the pull request belongs to: its origin, its installed dependencies. */
  readonly mainRoot: string;
  /** A pull request number or URL. */
  readonly ref: string;
  /** Leaves the worktree in place after the run, for propose and run --mutants. */
  readonly keep: boolean;
  /** Where this repository's pull request worktrees live, outside the checkout. */
  readonly worktrees: string;
  /** Spec paths for the unit lane, relative to `baseDir`. */
  readonly specs: readonly string[];
  /** What relative --specs paths resolve against: --repo when given, else the cwd. */
  readonly baseDir: string;
  readonly prs: PullRequestSource;
  readonly checkout: PullRequestCheckout;
  readonly linker: DependencyLinker;
  readonly source: ChangeSource;
  /** This run's process id and the start time of a process; the real ones unless a test swaps them. */
  readonly pid?: number;
  readonly startOf?: (pid: number) => string | undefined;
  /** The mutation run; the pipeline unless a test swaps it. */
  readonly run?: (input: PipelineInput) => Promise<{ report: Report; outDir: string }>;
}

/**
 * Checks a pull request without touching the checkout: reads it with the forge's CLI, fetches its
 * commits, refuses one that changes a lockfile, then runs the pipeline in a detached worktree at its
 * head with the checkout's dependencies linked in, and removes the worktree unless asked to keep it.
 */
export async function prCommand(input: PrCommandInput): Promise<{ report: Report; outDir: string; pr: PullRequest; worktree: string }> {
  const { mainRoot, checkout } = input;
  checkout.checkTop(mainRoot);
  const pr = input.prs.describe(mainRoot, input.ref);
  const origin = checkout.originRepo(mainRoot);
  if (origin?.toLowerCase() !== pr.repo.toLowerCase()) throw new UsageError(`${pr.url} is a pull request of ${pr.repo}, but the origin of ${mainRoot} is ${origin || 'not a known repository'}; pass --repo with a checkout of ${pr.repo}`);
  checkout.fetch(mainRoot, pr);
  const drift = checkout.lockfileDrift(mainRoot, pr.headSha);
  if (drift.length > 0) {
    throw new UsageError(`${drift.join(', ')} at the head of pull request ${pr.number} differ from the ones installed in ${mainRoot}, so its linked dependencies would not match; install them in a checkout of its branch and run weakspot diff there`);
  }
  // A run that keeps its worktree uses the one place the next --keep run looks; any other run gets a folder of its own.
  const name = `pr-${pr.number}-${pr.headSha.slice(0, 12)}`;
  const pid = input.pid ?? process.pid;
  const startOf = input.startOf ?? processStart;
  const dir = path.join(input.worktrees, input.keep ? name : `${name}-${pid}`);
  if (existsSync(dir)) {
    const marker = readMarker(dir);
    if (marker && inUse(marker, startOf)) throw new UsageError(`${dir} is in use by weakspot pr (process ${marker.pid}); wait for it to finish`);
    // Only a worktree a --keep run finished with is reused; anything else there was left by a run that stopped.
    if (!marker?.kept) checkout.remove(mainRoot, dir);
  }
  const reused = checkout.add(mainRoot, dir, pr.headSha);
  const started = startOf(pid) ?? '';
  writeMarker(dir, { pid, started, kept: false });
  input.log(`pull request ${pr.number} at ${pr.headSha.slice(0, 12)}: ${reused ? 'reusing the kept' : 'new'} worktree ${dir}`);
  try {
    if (!reused) input.log(`linked dependencies of ${input.linker.link(mainRoot, dir).join(', ') || 'no package'} from ${mainRoot}`);
    const changed = input.source.changes({ repoRoot: dir, base: pr.baseSha, scope: 'committed' });
    input.log(`${changed.length} changed file(s) against ${pr.baseRef} (${pr.baseSha.slice(0, 12)})`);
    const specs = specsInTree(input, dir, pr);
    const run = input.run ?? runPipeline;
    const result = await run({ ...input, repoRoot: dir, changed, specs, change: { kind: 'pr', detail: `${pr.url} at ${pr.headSha.slice(0, 12)}, against ${pr.baseRef}` } });
    return { ...result, pr, worktree: dir };
  } finally {
    if (input.keep) writeMarker(dir, { pid, started, kept: true });
    else checkout.remove(mainRoot, dir);
  }
}

/** In a pr worktree's root: which run made it, and whether a --keep run finished with it. */
export const MARKER = '.weakspot-pr.json';

interface Marker {
  readonly pid: number;
  /** When that process started, so a pid the system gave to another process later does not count. */
  readonly started: string;
  readonly kept: boolean;
}

function readMarker(dir: string): Marker | undefined {
  try {
    const raw = JSON.parse(readFileSync(path.join(dir, MARKER), 'utf8')) as Partial<Marker>;
    return typeof raw.pid === 'number' && typeof raw.started === 'string' && typeof raw.kept === 'boolean' ? { pid: raw.pid, started: raw.started, kept: raw.kept } : undefined;
  } catch {
    return undefined;
  }
}

function writeMarker(dir: string, marker: Marker): void {
  writeFileSync(path.join(dir, MARKER), `${JSON.stringify(marker)}\n`);
}

/** A run still going: not finished as kept, and the same process still running, started when the marker says. */
function inUse(marker: Marker, startOf: (pid: number) => string | undefined): boolean {
  return !marker.kept && marker.started !== '' && startOf(marker.pid) === marker.started;
}

/** When a process started, as `ps` prints it; undefined when there is no such process. */
export function processStart(pid: number): string | undefined {
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** --specs read like diff's, against the cwd or --repo, but must exist in the pull request's tree, which may add them. */
function specsInTree(input: PrCommandInput, dir: string, pr: PullRequest): string[] {
  return input.specs.map((given) => {
    const abs = path.resolve(input.baseDir, given);
    if (!isInside(input.mainRoot, abs)) throw new UsageError(`${abs} is outside the repo root ${input.mainRoot}`);
    const rel = repoRelative(input.mainRoot, abs);
    if (!existsSync(path.join(dir, rel))) throw new UsageError(`spec ${rel} is not in pull request ${pr.number} at ${pr.headSha.slice(0, 12)}`);
    return rel;
  });
}

/**
 * `pr --clean`: removes this repository's pr worktrees and any folder left where one was, except those a
 * run is still using, which it names instead.
 */
export function cleanWorktrees(checkout: PullRequestCheckout, mainRoot: string, worktrees: string, startOf: (pid: number) => string | undefined = processStart): { removed: string[]; inUse: string[] } {
  const kept = checkout.list(mainRoot, worktrees);
  // git lists worktrees by their real path, so leftovers are compared the same way.
  const leftover = existsSync(worktrees) ? readdirSync(worktrees).filter((n) => n.startsWith('pr-')).map((n) => realpathSync(path.join(worktrees, n))) : [];
  const removed: string[] = [];
  const busy: string[] = [];
  for (const dir of new Set([...kept, ...leftover])) {
    const marker = readMarker(dir);
    if (marker && inUse(marker, startOf)) {
      busy.push(dir);
      continue;
    }
    checkout.remove(mainRoot, dir);
    removed.push(dir);
  }
  return { removed, inUse: busy };
}
