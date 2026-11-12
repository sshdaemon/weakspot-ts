import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { FsPackageLocator } from '../adapters/fs/package-locator.ts';
import { GitChangeSource, GitError, remoteRepoName } from '../adapters/git/git-change-source.ts';
import { SpecCommandError } from '../adapters/shell/command-spec-finder.ts';
import { PrepareError } from '../adapters/shell/run-command.ts';
import { laneFinder } from '../adapters/spec/lane-finder.ts';
import { StrykerEngine, TestsFailBeforeMutationError } from '../adapters/stryker/stryker-engine.ts';
import { ImportSpecFinder } from '../adapters/ts/import-spec-finder.ts';
import { VitestRunner } from '../adapters/vitest/vitest-runner.ts';
import type { Report } from '../report/types.ts';
import { ConfigError, loadConfig, weakspotHome } from './config.ts';
import { diffCommand } from './diff-command.ts';
import { filesCommand } from './files-command.ts';
import { OPTIONS, USAGE, checkUsage, laneSelectionOf, scopeOf, withFlags } from './flags.ts';
import { UsageError, type PipelineLane } from './pipeline.ts';

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
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
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

  const log = values.quiet ? () => {} : (line: string) => process.stderr.write(`${line}\n`);
  const baseDir = values.repo ? path.resolve(values.repo) : process.cwd();
  const start = command === 'files' ? path.dirname(path.resolve(rest[0]!.replace(/:\d+(-\d+)?$/, ''))) : process.cwd();
  const repoRoot = values.repo ? path.resolve(values.repo) : new FsPackageLocator().repoRoot(start);
  const remote = remoteRepoName(repoRoot);
  const { config: loaded, source } = loadConfig(repoRoot, remote);
  const config = withFlags(loaded, values);
  const laneSelection = laneSelectionOf(values, config);
  log(`repo: ${repoRoot} (config: ${source})`);
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  const out = values.out ? path.resolve(values.out) : path.join(weakspotHome(), 'runs', remote ?? path.basename(repoRoot), stamp);

  const interrupt = new AbortController();
  const onSignal = () => interrupt.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const started = Date.now();
  const importFinder = new ImportSpecFinder(config.specDepth, config);
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
    lanes: extraLanes.map((l): PipelineLane => ({ config: l, finder: laneFinder(l, config) })),
    laneSelection,
    packages: new FsPackageLocator(extraLanes.map((l) => l.config!)),
    log,
    commandLine: `weakspot ${argv.join(' ')}`,
    version: toolVersion(),
    signal: interrupt.signal,
    specs: (values.specs ?? []).flatMap((s) => s.split(',')).filter(Boolean),
  };
  const source_ = new GitChangeSource();
  const base = values.base ?? config.base ?? source_.defaultBase(repoRoot);
  if (command === 'diff' && !base) throw new UsageError('no base to compare with: pass --base <ref>, set "base" in the repo config, or set origin/HEAD (git remote set-head origin -a)');
  const pending = command === 'files' ? filesCommand({ ...shared, files: rest }) : diffCommand({ ...shared, source: source_, base: base!, scope: scopeOf(values) });
  const { report } = await pending.finally(() => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  });
  process.stdout.write(`${summaryLine(report, Date.now() - started)}\nreport: ${path.join(out, 'report.md')}\n`);
  return 0;
}

function toolVersion(): string {
  const pkg = path.join(import.meta.dirname, '..', '..', 'package.json');
  return (JSON.parse(readFileSync(pkg, 'utf8')) as { version: string }).version;
}

function summaryLine(report: Report, elapsedMs: number): string {
  const killed = report.mutants.filter((m) => m.status === 'Killed' || m.status === 'Timeout').length;
  const warn = report.warnings.length > 0 ? `, ${report.warnings.length} warning(s)` : '';
  return `${report.packages.length} package(s), ${report.mutants.length} mutants, ${killed} killed, ${report.survivors.length} survivor(s), ${report.untested.length} untested file(s)${warn}, ${(elapsedMs / 1000).toFixed(1)}s`;
}
