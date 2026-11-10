import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { FsPackageLocator } from '../adapters/fs/package-locator.ts';
import { SiblingSpecFinder } from '../adapters/fs/sibling-spec-finder.ts';
import { StrykerEngine, TestsFailBeforeMutationError } from '../adapters/stryker/stryker-engine.ts';
import { VitestRunner } from '../adapters/vitest/vitest-runner.ts';
import { ConfigError, loadConfig, positiveInt, weakspotHome } from './config.ts';
import { UsageError, filesCommand } from './files-command.ts';

const USAGE = `weakspot <command> [options]

Commands
  files <path[:start-end]>...   mutate the given files (or line ranges) and run their specs

Options
  --repo <dir>        repo root; relative paths are resolved against it (default: found from the first file, paths relative to the cwd)
  --specs <a,b>       spec files to run, instead of sibling discovery (repeatable)
  --out <dir>         where to write report.json and report.md (default: ~/.weakspot/runs/<repo>/<time>)
  --timeout-ms <n>    per-mutant time limit (default from config, 3000)
  --concurrency <n>   engine worker count (default: cores, max 8)
  --exclude <a,b>     mutator names to switch off (replaces the config list)
  --quiet             only print the final summary
`;

export async function main(argv: string[]): Promise<number> {
  try {
    return await run(argv);
  } catch (err) {
    if (err instanceof UsageError || err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    if (err instanceof TestsFailBeforeMutationError) {
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
      specs: { type: 'string', multiple: true },
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
  if (command !== 'files') throw new UsageError(`unknown command ${command}\n${USAGE}`);
  if (rest.length === 0) throw new UsageError('files: give at least one path');

  const log = values.quiet ? () => {} : (line: string) => process.stderr.write(`${line}\n`);
  const packages = new FsPackageLocator();
  const baseDir = values.repo ? path.resolve(values.repo) : process.cwd();
  const firstPath = rest[0]!.replace(/:\d+(-\d+)?$/, '');
  const repoRoot = values.repo ? path.resolve(values.repo) : packages.repoRoot(path.dirname(path.resolve(firstPath)));
  const { config: loaded, source } = loadConfig(repoRoot);
  const config = {
    ...loaded,
    timeoutMs: positiveInt(values['timeout-ms'], '--timeout-ms', 'command line') ?? loaded.timeoutMs,
    concurrency: positiveInt(values.concurrency, '--concurrency', 'command line') ?? loaded.concurrency,
    excludedMutations: values.exclude ? values.exclude.split(',').filter(Boolean) : loaded.excludedMutations,
  };
  log(`repo: ${repoRoot} (config: ${source})`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = values.out ? path.resolve(values.out) : path.join(weakspotHome(), 'runs', path.basename(repoRoot), stamp);
  const version = (JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8')) as { version: string }).version;

  const interrupt = new AbortController();
  const onSignal = () => interrupt.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const started = Date.now();
  const { report } = await filesCommand({
    files: rest,
    specs: (values.specs ?? []).flatMap((s) => s.split(',')).filter(Boolean),
    repoRoot,
    baseDir,
    out,
    config,
    runner: new VitestRunner(config.vitest),
    engine: new StrykerEngine(),
    specFinder: new SiblingSpecFinder(),
    packages,
    log,
    commandLine: `weakspot ${argv.join(' ')}`,
    version,
    signal: interrupt.signal,
  }).finally(() => {
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
