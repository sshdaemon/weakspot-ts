import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { FsPackageLocator } from '../adapters/fs/package-locator.ts';
import { GitChangeSource, GitError, remoteRepoName } from '../adapters/git/git-change-source.ts';
import { SpecCommandError } from '../adapters/shell/command-spec-finder.ts';
import { PrepareError } from '../adapters/shell/run-command.ts';
import { laneFinder } from '../adapters/spec/lane-finder.ts';
import { StrykerEngine, TestsFailBeforeMutationError } from '../adapters/stryker/stryker-engine.ts';
import { ImportSpecFinder } from '../adapters/ts/import-spec-finder.ts';
import { VitestRunner } from '../adapters/vitest/vitest-runner.ts';
import { parseLaneSelection } from '../mutation/lanes.ts';
import { ConfigError, loadConfig, positiveInt, weakspotHome, type ToolConfig } from './config.ts';
import { diffCommand } from './diff-command.ts';
import { filesCommand } from './files-command.ts';
import { UsageError, type PipelineLane } from './pipeline.ts';

const USAGE = `weakspot <command> [options]

Commands
  diff                          mutate what changed against the base branch (committed, staged, unstaged and untracked)
  files <path[:start-end]>...   mutate the given files (or line ranges)

Options
  --repo <dir>        repo root; relative paths are resolved against it (default: found from the cwd or the first file)
  --base <ref>        diff: ref to compare with (default: the repo config's base, else the remote's default branch)
  --staged            diff: only committed and staged changes
  --committed         diff: only committed changes
  --specs <a,b>       spec files to run in the unit lane, instead of import discovery (repeatable)
  --depth <1|2>       import hops between a spec and a source that still count (default from config, 1)
  --lanes <a,b|all>   run the named lanes (or all) for every file, instead of later lanes taking only what the unit lane left untested
  --out <dir>         where to write report.json and report.md (default: ~/.weakspot/runs/<repo>/<time>)
  --timeout-ms <n>    per-mutant time limit for every lane (default from config, 3000)
  --concurrency <n>   engine worker count for every lane (default: cores, max 8)
  --exclude <a,b>     mutator names to switch off (replaces the config list)
  --quiet             only print the final summary
`;

export async function main(argv: string[]): Promise<number> {
  try {
    return await run(argv);
  } catch (err) {
    if (err instanceof UsageError || err instanceof ConfigError || err instanceof GitError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    if (err instanceof TestsFailBeforeMutationError || err instanceof PrepareError || err instanceof SpecCommandError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    if (err instanceof Error && err.message === 'interrupted') {
      process.stderr.write('interrupted, engine runs stopped\n');
      return 130;
    }
    throw err;
  }
}

async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      base: { type: 'string' },
      staged: { type: 'boolean' },
      committed: { type: 'boolean' },
      specs: { type: 'string', multiple: true },
      depth: { type: 'string' },
      lanes: { type: 'string' },
      out: { type: 'string' },
      'timeout-ms': { type: 'string' },
      concurrency: { type: 'string' },
      exclude: { type: 'string' },
      quiet: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!command) {
    process.stderr.write(USAGE);
    return 2;
  }
  if (command !== 'files' && command !== 'diff') throw new UsageError(`unknown command ${command}\n${USAGE}`);
  if (command === 'files' && rest.length === 0) throw new UsageError('files: give at least one path');
  if (command === 'diff' && rest.length > 0) throw new UsageError(`diff takes no paths; use --repo to point at a checkout`);
  if (values.staged && values.committed) throw new UsageError('--staged and --committed exclude each other');
  if (command === 'files' && (values.base || values.staged || values.committed)) throw new UsageError('--base, --staged and --committed apply to diff only');

  const log = values.quiet ? () => {} : (line: string) => process.stderr.write(`${line}\n`);
  const baseDir = values.repo ? path.resolve(values.repo) : process.cwd();
  const start = command === 'files' ? path.dirname(path.resolve(rest[0]!.replace(/:\d+(-\d+)?$/, ''))) : process.cwd();
  const repoRoot = values.repo ? path.resolve(values.repo) : new FsPackageLocator().repoRoot(start);
  const remote = remoteRepoName(repoRoot);
  const { config: loaded, source } = loadConfig(repoRoot, remote);
  const depth = positiveInt(values.depth, '--depth', 'command line') ?? loaded.specDepth;
  if (depth > 2) throw new UsageError('--depth must be 1 or 2');
  const timeoutMs = positiveInt(values['timeout-ms'], '--timeout-ms', 'command line');
  const concurrency = positiveInt(values.concurrency, '--concurrency', 'command line');
  const config: ToolConfig = {
    ...loaded,
    specDepth: depth,
    timeoutMs: timeoutMs ?? loaded.timeoutMs,
    concurrency: concurrency ?? loaded.concurrency,
    excludedMutations: values.exclude ? values.exclude.split(',').filter(Boolean) : loaded.excludedMutations,
    // A flag applies to every lane; a lane's own limit only stands when the flag is absent.
    lanes: loaded.lanes.map((l) => ({ ...l, timeoutMs: timeoutMs ?? l.timeoutMs, concurrency: concurrency ?? l.concurrency })),
  };
  let laneSelection;
  try {
    laneSelection = parseLaneSelection(values.lanes, config.lanes.map((l) => l.name));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  if (values.specs && Array.isArray(laneSelection) && !laneSelection.includes('unit')) {
    throw new UsageError('--specs names specs for the unit lane; include unit in --lanes or drop --specs');
  }
  log(`repo: ${repoRoot} (config: ${source})`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = values.out ? path.resolve(values.out) : path.join(weakspotHome(), 'runs', remote ?? path.basename(repoRoot), stamp);
  const version = (JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8')) as { version: string }).version;

  const interrupt = new AbortController();
  const onSignal = () => interrupt.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const started = Date.now();
  const importFinder = new ImportSpecFinder(config.specDepth, config);
  const extraLanes = config.lanes.slice(1);
  const lanes: PipelineLane[] = extraLanes.map((l) => ({ config: l, finder: laneFinder(l, config) }));
  const shared = {
    repoRoot,
    baseDir,
    out,
    config,
    runner: new VitestRunner(config.vitest),
    engine: new StrykerEngine(),
    specFinder: importFinder,
    imports: importFinder,
    lanes,
    laneSelection,
    packages: new FsPackageLocator(extraLanes.map((l) => l.config!)),
    log,
    commandLine: `weakspot ${argv.join(' ')}`,
    version,
    signal: interrupt.signal,
    specs: (values.specs ?? []).flatMap((s) => s.split(',')).filter(Boolean),
  };
  const source_ = new GitChangeSource();
  const base = values.base ?? config.base ?? source_.defaultBase(repoRoot);
  if (command === 'diff' && !base) throw new UsageError('no base to compare with: pass --base <ref>, set "base" in the repo config, or set origin/HEAD (git remote set-head origin -a)');
  const { report } = await (command === 'files'
    ? filesCommand({ ...shared, files: rest })
    : diffCommand({
        ...shared,
        source: source_,
        base: base!,
        scope: values.committed ? 'committed' : values.staged ? 'staged' : 'working',
      })
  ).finally(() => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  });
  const total = report.mutants.length;
  const killed = report.mutants.filter((m) => m.status === 'Killed' || m.status === 'Timeout').length;
  const warn = report.warnings.length > 0 ? `, ${report.warnings.length} warning(s)` : '';
  process.stdout.write(
    `${report.packages.length} package(s), ${total} mutants, ${killed} killed, ${report.survivors.length} survivor(s), ${report.untested.length} untested file(s)${warn}, ${((Date.now() - started) / 1000).toFixed(1)}s\n` +
      `report: ${path.join(out, 'report.md')}\n`,
  );
  return 0;
}
