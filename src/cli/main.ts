import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { FsPackageLocator } from '../adapters/fs/package-locator.ts';
import { JsonSuppressionStore } from '../adapters/fs/suppression-store.ts';
import { GitChangeSource, remoteRepoName } from '../adapters/git/git-change-source.ts';
import { laneFinder } from '../adapters/spec/lane-finder.ts';
import { StrykerEngine } from '../adapters/stryker/stryker-engine.ts';
import { ImportSpecFinder } from '../adapters/ts/import-spec-finder.ts';
import { TsSourceInspector } from '../adapters/ts/source-inspector.ts';
import { VitestRunner } from '../adapters/vitest/vitest-runner.ts';
import type { Report } from '../report/types.ts';
import { loadConfig, weakspotHome } from './config.ts';
import { readChangeList, repoRootOf } from './change-list-input.ts';
import { diffCommand } from './diff-command.ts';
import { filesCommand } from './files-command.ts';
import { OPTIONS, USAGE, checkUsage, laneSelectionOf, scopeOf, withFlags, type Flags } from './flags.ts';
import { exitCodeFor, exitCodeOf, messageFor } from './exit-codes.ts';
import { UsageError, type PipelineLane } from './pipeline.ts';

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

  const log = values.quiet ? () => {} : (line: string) => process.stderr.write(`${line}\n`);
  const baseDir = values.repo ? path.resolve(values.repo) : process.cwd();
  const start = command === 'files' ? path.dirname(path.resolve(rest[0]!.replace(/:\d+(-\d+)?$/, ''))) : process.cwd();
  const changeList = values.changes === undefined ? undefined : { list: readChangeList(values.changes), file: path.resolve(values.changes) };
  const repoRoot = repoRootOf(values.repo, changeList?.list, () => new FsPackageLocator().repoRoot(start));
  const remote = remoteRepoName(repoRoot);
  const { config: loaded, source } = loadConfig(repoRoot, remote);
  const config = withFlags(loaded, values);
  const laneSelection = laneSelectionOf(values, config);
  log(`repo: ${repoRoot} (config: ${source})`);
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  const out = values.out ? path.resolve(values.out) : path.join(weakspotHome(), 'runs', remote ?? path.basename(repoRoot), stamp);
  const suppressions = { store: suppressionStore(), repoKey: remote ?? path.basename(repoRoot) };

  const interrupt = new AbortController();
  const onSignal = () => interrupt.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const started = Date.now();
  const cacheDir = path.join(weakspotHome(), 'cache');
  const importFinder = new ImportSpecFinder(config.specDepth, config, 'unit', cacheDir);
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
    lanes: extraLanes.map((l): PipelineLane => ({ config: l, finder: laneFinder(l, config, cacheDir) })),
    laneSelection,
    packages: new FsPackageLocator(extraLanes.map((l) => l.config!)),
    log,
    commandLine: `weakspot ${argv.join(' ')}`,
    version: toolVersion(),
    signal: interrupt.signal,
    specs: (values.specs ?? []).flatMap((s) => s.split(',')).filter(Boolean),
  };
  const source_ = new GitChangeSource();
  const base = changeList?.list.base ?? values.base ?? config.base ?? source_.defaultBase(repoRoot);
  if (command === 'diff' && !base) throw new UsageError('no base to compare with: pass --base <ref>, set "base" in the repo config, or set origin/HEAD (git remote set-head origin -a)');
  const pending = command === 'files' ? filesCommand({ ...shared, files: rest }) : diffCommand({ ...shared, source: source_, base: base!, scope: scopeOf(values), ...(changeList ? { changeList } : {}) });
  const { report } = await pending.finally(() => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  });
  process.stdout.write(`${summaryLine(report, Date.now() - started)}\nreport: ${path.join(out, 'report.md')}\n`);
  return exitCodeOf(report);
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
  return `${report.packages.length} package(s), ${total} mutants, ${killed} killed, ${report.survivors.length - noise - acceptedSurvivors} survivor(s)${hidden.length > 0 ? ` (and ${hidden.join(', ')})` : ''}, ${report.untested.length - acceptedUntested} untested file(s)${warn}, ${(elapsedMs / 1000).toFixed(1)}s`;
}
