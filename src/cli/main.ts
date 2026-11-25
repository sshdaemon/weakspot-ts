import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { FsPackageLocator, packagesWithConfig } from '../adapters/fs/package-locator.ts';
import { CopySandboxFactory } from '../adapters/fs/copy-sandbox.ts';
import { JsonCoverageMapStore } from '../adapters/fs/coverage-map-store.ts';
import { JsonMutantCache } from '../adapters/fs/mutant-cache.ts';
import { NodeModulesLinker } from '../adapters/fs/node-modules-linker.ts';
import { JsonSuppressionStore } from '../adapters/fs/suppression-store.ts';
import { GhPullRequestSource } from '../adapters/gh/gh-pull-request-source.ts';
import { GitPullRequestCheckout } from '../adapters/git/pr-checkout.ts';
import { GitChangeSource, remoteRepoName } from '../adapters/git/git-change-source.ts';
import { laneFinder } from '../adapters/spec/lane-finder.ts';
import { StrykerEngine } from '../adapters/stryker/stryker-engine.ts';
import { ImportSpecFinder } from '../adapters/ts/import-spec-finder.ts';
import { TsPlaceholderFinder } from '../adapters/ts/placeholder-finder.ts';
import { TsSourceInspector } from '../adapters/ts/source-inspector.ts';
import { VitestRunner } from '../adapters/vitest/vitest-runner.ts';
import type { Report } from '../report/types.ts';
import { loadConfig, repoKeyOf, weakspotHome } from './config.ts';
import { readChangeList, repoRootOf } from './change-list-input.ts';
import { diffPipelineInput } from './diff-command.ts';
import { filesPipelineInput } from './files-command.ts';
import { readMutantEntries, readPlaceholders, runMutants } from './mutants-command.ts';
import { mapCommand, mapSummary, planMap } from './map-command.ts';
import { cleanWorktrees, prCommand } from './pr-command.ts';
import { PLACEHOLDERS_FILE, propose, proposeSummary } from './propose-command.ts';
import { OPTIONS, USAGE, checkUsage, laneSelectionOf, scopeOf, withFlags, type Flags } from './flags.ts';
import { EXIT, exitCodeFor, exitCodeOf, messageFor } from './exit-codes.ts';
import { runPipeline, UsageError, type PipelineLane } from './pipeline.ts';

/** Never throws: every failure is printed and mapped to an exit code (see EXIT). */
export async function main(argv: string[]): Promise<number> {
  try {
    return await run(argv);
  } catch (err) {
    process.stderr.write(`${messageFor(err)}\n`);
    return exitCodeFor(err);
  }
}

async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseFlags(argv);
  const [command, ...rest] = positionals;
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!command) {
    process.stderr.write(USAGE);
    return 2;
  }
  checkUsage(command, rest, values);
  if (command === 'accept') return accept(rest[0]!, values);
  if (command === 'run') return runCommand(argv, values);
  if (command === 'map') return mapLane(rest[0]!, values);

  const log = values.quiet ? () => {} : (line: string) => process.stderr.write(`${line}\n`);
  const baseDir = values.repo ? path.resolve(values.repo) : process.cwd();
  const named = command === 'files' || (command === 'propose' && rest.length > 0);
  const start = named ? path.dirname(path.resolve(rest[0]!.replace(/:\d+(-\d+)?$/, ''))) : process.cwd();
  const changeList = values.changes === undefined ? undefined : { list: readChangeList(values.changes), file: path.resolve(values.changes) };
  const repoRoot = repoRootOf(values.repo, changeList?.list, () => new FsPackageLocator().repoRoot(start));
  const remote = remoteRepoName(repoRoot);
  const { config: loaded, source } = loadConfig(repoRoot, remote);
  const config = withFlags(loaded, values);
  const laneSelection = laneSelectionOf(values, config);
  log(`repo: ${repoRoot} (config: ${source})`);
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  const out = values.out ? path.resolve(values.out) : path.join(weakspotHome(), 'runs', remote ?? path.basename(repoRoot), stamp);
  const repoKey = repoKeyOf(repoRoot, remote);
  const suppressions = { store: suppressionStore(), repoKey };
  const worktrees = path.join(weakspotHome(), 'worktrees', repoKey);
  if (command === 'pr' && values.clean) {
    const { removed, inUse } = cleanWorktrees(new GitPullRequestCheckout(), repoRoot, worktrees);
    const busy = inUse.length > 0 ? `\nleft ${inUse.length} in use by a running weakspot pr${inUse.map((d) => `\n  ${d}`).join('')}` : '';
    process.stdout.write(`removed ${removed.length} worktree(s)${removed.map((d) => `\n  ${d}`).join('')}${busy}\n`);
    return 0;
  }

  const interrupt = new AbortController();
  const started = Date.now();
  const cacheDir = path.join(weakspotHome(), 'cache');
  const importFinder = new ImportSpecFinder(config.specDepth, config, 'unit', cacheDir, repoKey);
  const extraLanes = config.lanes.slice(1);
  const shared = {
    repoRoot,
    baseDir,
    out,
    config,
    runner: new VitestRunner(config.vitest),
    engine: new StrykerEngine(),
    specFinder: importFinder,
    imports: importFinder,
    inspector: new TsSourceInspector(),
    suppressions,
    lanes: extraLanes.map((l): PipelineLane => ({ config: l, finder: laneFinder(l, config, cacheDir, repoKey, coverageMaps()) })),
    laneSelection,
    packages: new FsPackageLocator(extraLanes.map((l) => l.config!)),
    log,
    commandLine: `weakspot ${argv.join(' ')}`,
    version: toolVersion(),
    signal: interrupt.signal,
    specs: (values.specs ?? []).flatMap((s) => s.split(',')).filter(Boolean),
  };
  const source_ = new GitChangeSource();
  if (command === 'pr') {
    const pr = { ...shared, mainRoot: repoRoot, ref: rest[0]!, keep: values.keep ?? false, worktrees, prs: new GhPullRequestSource(), checkout: new GitPullRequestCheckout(), linker: new NodeModulesLinker(), source: source_ };
    const done = await withSignals(interrupt, () => prCommand(pr));
    process.stdout.write(`${summaryLine(done.report, Date.now() - started)}\nreport: ${path.join(out, 'report.md')}\n${values.keep ? `worktree: ${done.worktree}\nbase: ${done.pr.baseSha} (propose --repo ${done.worktree} --base ${done.pr.baseSha} offers the same lines)\n` : ''}`);
    return exitCodeOf(done.report);
  }
  const base = changeList?.list.base ?? values.base ?? config.base ?? source_.defaultBase(repoRoot);
  if (!named && !base) throw new UsageError('no base to compare with: pass --base <ref>, set "base" in the repo config, or set origin/HEAD (git remote set-head origin -a)');
  const input = named ? filesPipelineInput({ ...shared, files: rest }) : diffPipelineInput({ ...shared, source: source_, base: base!, scope: scopeOf(values), ...(changeList ? { changeList } : {}) });
  if (command === 'propose') {
    const done = propose({ ...input, finder: new TsPlaceholderFinder(), cache: { store: mutantCache(), repoKey }, instructions: authorPrompt() });
    process.stdout.write(`${proposeSummary(done.file, done.path)}\n`);
    return 0;
  }
  const { report } = await withSignals(interrupt, () => runPipeline(input));
  process.stdout.write(`${summaryLine(report, Date.now() - started)}\nreport: ${path.join(out, 'report.md')}\n`);
  return exitCodeOf(report);
}

/** `map <lane>`: the lane must list coverage, or the map would never be read. */
async function mapLane(laneName: string, values: Flags): Promise<number> {
  const log = values.quiet ? () => {} : (line: string) => process.stderr.write(`${line}\n`);
  const repoRoot = values.repo ? path.resolve(values.repo) : new FsPackageLocator().repoRoot(process.cwd());
  const git = new GitChangeSource();
  // Map paths are relative to the top; a map made from a subfolder would be read by no run.
  git.checkTopOf(repoRoot);
  const remote = remoteRepoName(repoRoot);
  const { config, source } = loadConfig(repoRoot, remote);
  log(`repo: ${repoRoot} (config: ${source})`);
  const { lane, repoKey, workDir } = planMap({ repoRoot, remote, config, laneName, out: values.out, home: weakspotHome(), now: new Date() });
  const interrupt = new AbortController();
  const done = await withSignals(interrupt, () =>
    mapCommand({
      repoRoot,
      repoKey,
      lane,
      runner: new VitestRunner(config.vitest),
      store: coverageMaps(),
      patterns: config,
      packages: packagesWithConfig(repoRoot, lane.config!),
      head: git.head(repoRoot),
      workDir,
      log,
      signal: interrupt.signal,
    }),
  );
  process.stdout.write(`${mapSummary(done)}\n`);
  return done.failed.length > 0 ? EXIT.failed : EXIT.clean;
}

/** Ctrl-C, SIGTERM and SIGHUP abort `interrupt` while `work` runs. */
async function withSignals<T>(interrupt: AbortController, work: () => Promise<T>): Promise<T> {
  const onSignal = () => interrupt.abort();
  // SIGHUP too: closing the terminal must still let a run clean up its worktree and sandboxes.
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  for (const sig of signals) process.once(sig, onSignal);
  try {
    return await work();
  } finally {
    for (const sig of signals) process.off(sig, onSignal);
  }
}

/** `run --mutants`: the repo and the default --out come from the placeholders file. */
async function runCommand(argv: string[], values: Flags): Promise<number> {
  const log = values.quiet ? () => {} : (line: string) => process.stderr.write(`${line}\n`);
  const mutantsPath = path.resolve(values.mutants!);
  const placeholdersPath = path.resolve(values.placeholders ?? path.join(path.dirname(mutantsPath), PLACEHOLDERS_FILE));
  const placeholders = readPlaceholders(placeholdersPath);
  const entries = readMutantEntries(mutantsPath);
  const repoRoot = placeholders.repo;
  if (values.repo && path.resolve(values.repo) !== repoRoot) throw new UsageError(`${placeholdersPath} is for ${repoRoot}, not --repo ${path.resolve(values.repo)}`);
  const remote = remoteRepoName(repoRoot);
  const { config: loaded, source } = loadConfig(repoRoot, remote);
  const config = withFlags(loaded, values);
  log(`repo: ${repoRoot} (config: ${source})`);
  const repoKey = repoKeyOf(repoRoot, remote);
  const out = values.out ? path.resolve(values.out) : path.dirname(placeholdersPath);
  const interrupt = new AbortController();
  const started = Date.now();
  const { report } = await withSignals(interrupt, () => runMutants({
    placeholders,
    placeholdersPath,
    mutantsPath,
    entries,
    out,
    config,
    runner: new VitestRunner(config.vitest),
    sandboxes: new CopySandboxFactory(),
    finder: new TsPlaceholderFinder(),
    inspector: new TsSourceInspector(),
    suppressions: { store: suppressionStore(), repoKey },
    cache: { store: mutantCache(), repoKey },
    log,
    commandLine: `weakspot ${argv.join(' ')}`,
    version: toolVersion(),
    signal: interrupt.signal,
  }));
  process.stdout.write(`${summaryLine(report, Date.now() - started)}\nreport: ${path.join(out, 'report.md')}\n`);
  return exitCodeOf(report);
}

function coverageMaps(): JsonCoverageMapStore {
  return new JsonCoverageMapStore(path.join(weakspotHome(), 'maps'));
}

function mutantCache(): JsonMutantCache {
  return new JsonMutantCache(path.join(weakspotHome(), 'cache', 'mutants'));
}

/** The prompt shipped with the tool, copied into every placeholders file. */
function authorPrompt(): string {
  return readFileSync(path.join(import.meta.dirname, '..', '..', 'docs', 'mutant-author.md'), 'utf8');
}

/** Node's parser errors (an unknown flag, a missing value) are the caller's mistake, so a usage error. */
function parseFlags(argv: string[]) {
  try {
    return parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
  } catch (err) {
    if (err instanceof Error && String((err as { code?: unknown }).code ?? '').startsWith('ERR_PARSE_ARGS_')) throw new UsageError(`${err.message}\n${USAGE}`);
    throw err;
  }
}

function suppressionStore(): JsonSuppressionStore {
  return new JsonSuppressionStore(path.join(weakspotHome(), 'accepted.json'));
}

/** Keyed like the repo config: the origin remote's repository name, so worktrees share decisions. */
function accept(id: string, values: Flags): number {
  const repoRoot = values.repo ? path.resolve(values.repo) : new FsPackageLocator().repoRoot(process.cwd());
  const repo = remoteRepoName(repoRoot) ?? path.basename(repoRoot);
  const store = suppressionStore();
  if (values.revoke) {
    if (!store.revoke(repo, id)) throw new UsageError(`${id} was not accepted for ${repo}`);
    process.stdout.write(`revoked ${id} for ${repo}\n`);
    return 0;
  }
  store.accept({ repo, id, reason: values.reason!.trim(), date: new Date().toISOString() });
  process.stdout.write(`accepted ${id} for ${repo}\n`);
  return 0;
}

function toolVersion(): string {
  const pkg = path.join(import.meta.dirname, '..', '..', 'package.json');
  return (JSON.parse(readFileSync(pkg, 'utf8')) as { version: string }).version;
}

/** First-pass mutants only; retries in a later lane are reported as kills there, not counted twice. */
export function summaryLine(report: Report, elapsedMs: number): string {
  const first = report.packages.filter((p) => !p.escalated);
  const total = first.reduce((n, p) => n + Object.values(p.counts).reduce((a, b) => a + b, 0), 0);
  const killed = first.reduce((n, p) => n + (p.counts['Killed'] ?? 0) + (p.counts['Timeout'] ?? 0), 0);
  const noise = report.survivors.filter((s) => s.noise && !s.accepted).length;
  const acceptedSurvivors = report.survivors.filter((s) => s.accepted).length;
  const acceptedUntested = report.accepted.filter((a) => a.id.endsWith('#untested')).length;
  const hidden = [
    report.killedLater.length > 0 ? `${report.killedLater.length} killed in a later lane` : '',
    noise > 0 ? `${noise} noise` : '',
    acceptedSurvivors + acceptedUntested > 0 ? `${acceptedSurvivors + acceptedUntested} accepted` : '',
  ].filter(Boolean);
  const warn = report.warnings.length > 0 ? `, ${report.warnings.length} warning(s)` : '';
  const rejected = report.model && report.model.rejected.length > 0 ? `, ${report.model.rejected.length} model answer(s) rejected` : '';
  return `${report.packages.length} package(s), ${total} mutants, ${killed} killed, ${report.survivors.length - noise - acceptedSurvivors} survivor(s)${hidden.length > 0 ? ` (and ${hidden.join(', ')})` : ''}, ${report.untested.length - acceptedUntested} untested file(s)${warn}${rejected}, ${(elapsedMs / 1000).toFixed(1)}s`;
}
