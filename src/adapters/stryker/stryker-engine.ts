import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { escapeGlob } from '../../change/glob.ts';
import { repoRelative } from '../../change/paths.ts';
import { LineRange } from '../../change/ranges.ts';
import type { LineRange as Range } from '../../change/types.ts';
import type { EngineRunOptions, EngineRunResult, Mutant, MutantStatus, PackagePlan } from '../../mutation/types.ts';
import type { MutationEngine } from '../../ports/mutation-engine.ts';
import type { TestRunner } from '../../ports/test-runner.ts';

interface StrykerMutant {
  id: string;
  mutatorName: string;
  replacement?: string;
  location: { start: { line: number; column: number }; end: { line: number; column: number } };
  status: MutantStatus;
  statusReason?: string;
  coveredBy?: string[];
  killedBy?: string[];
  static?: boolean;
}
interface StrykerReport {
  files: Record<string, { mutants: StrykerMutant[] }>;
  testFiles?: Record<string, { tests: unknown[] }>;
}

/** The engine was killed because a sibling run failed; never the cause of a failure. */
export class CancelledError extends Error {
  constructor(pkgName: string) {
    super(`run cancelled for ${pkgName}`);
    this.name = 'CancelledError';
  }
}

export class TestsFailBeforeMutationError extends Error {
  constructor(pkgName: string, detail: string) {
    super(`tests fail before mutation in ${pkgName}: ${detail}`);
    this.name = 'TestsFailBeforeMutationError';
  }
}

/**
 * StrykerJS driven through its CLI with a generated config, read back from its JSON report.
 * Runs with the package dir as cwd; temp dir and outputs go to `workDir`, outside the repo.
 */
export class StrykerEngine implements MutationEngine {
  readonly name = 'stryker';
  readonly workerIdVariable = 'STRYKER_MUTATOR_WORKER';

  async run(plan: PackagePlan, runner: TestRunner, opts: EngineRunOptions): Promise<EngineRunResult> {
    const slug = plan.pkg.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
    // Two packages can share a slug (`@scope/web` and `scope-web`); the dir hash keeps them apart.
    const dir = path.join(opts.workDir, `${slug}-${createHash('sha1').update(plan.pkg.dir).digest('hex').slice(0, 8)}-${plan.lane.name}`);
    mkdirSync(dir, { recursive: true });
    const shimPath = runner.writeShim(
      plan.pkg,
      {
        root: 'cwd',
        include: plan.specs.map((s) => repoRelative(plan.pkg.dir, path.join(opts.repoRoot, s))),
        env: plan.lane.env,
        workerIdVariable: this.workerIdVariable,
        workerOffset: opts.workerOffset,
      },
      path.join(dir, 'vitest.shim.mts'),
    );
    const reportPath = path.join(dir, 'stryker-report.json');
    const configPath = path.join(dir, 'stryker.config.json');
    const logPath = path.join(dir, 'stryker.log');
    const config = {
      ...runner.engineConfig(shimPath),
      mutate: plan.targets.flatMap((t) => mutatePatterns(repoRelative(plan.pkg.dir, path.join(opts.repoRoot, t.file)), t.ranges)),
      mutator: { excludedMutations: [...opts.excludedMutations] },
      checkers: [],
      reporters: ['json'],
      jsonReporter: { fileName: reportPath },
      tempDirName: path.join(dir, 'tmp'),
      cleanTempDir: 'always',
      // The package's own build output is never what its specs import; copying it only slows the sandbox. Anchored, so `src/build/` stays.
      ignorePatterns: ['/dist', '/build', '/coverage', '/.turbo'],
      incremental: false,
      concurrency: plan.lane.concurrency,
      timeoutMS: plan.lane.timeoutMs,
      logLevel: 'info',
      fileLogLevel: 'off',
      allowConsoleColors: false,
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    const started = Date.now();
    const code = await new Promise<number | null>((resolve, reject) => {
      const log = createWriteStream(logPath);
      const child = spawn(process.execPath, [strykerBin(), 'run', configPath], { cwd: plan.pkg.dir, env: process.env, detached: true });
      const onAbort = () => killGroup(child.pid);
      opts.signal.addEventListener('abort', onAbort, { once: true });
      const onLine = (chunk: Buffer) => {
        log.write(chunk);
        for (const line of chunk.toString().split('\n')) {
          if (/INFO|WARN|ERROR/.test(line)) opts.log(`[${plan.pkg.name}] ${line.replace(/\u001b\[\d+m/g, '').trim()}`);
        }
      };
      child.stdout.on('data', onLine);
      child.stderr.on('data', onLine);
      child.on('error', (err) => {
        opts.signal.removeEventListener('abort', onAbort);
        log.end();
        reject(err);
      });
      child.on('close', (c) => {
        opts.signal.removeEventListener('abort', onAbort);
        log.end();
        resolve(c);
      });
    });
    const durationMs = Date.now() - started;
    if (opts.signal.aborted) throw new CancelledError(plan.pkg.name);
    if (!existsSync(reportPath)) {
      const logText = readFileSync(logPath, 'utf8').replace(/\u001b\[\d+m/g, '');
      const failing = dryRunFailures(logText);
      if (failing !== undefined) {
        throw new TestsFailBeforeMutationError(plan.pkg.name, `${failing || 'see the log'} (${logPath})`);
      }
      const tail = logText.split('\n').filter((l) => /ERROR|Error|WARN/.test(l)).slice(-6).join('\n');
      throw new Error(`stryker exited with ${code} for ${plan.pkg.name} and wrote no report. Log: ${logPath}\n${tail}`);
    }
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as StrykerReport;
    const mutants: Mutant[] = [];
    for (const [file, entry] of Object.entries(report.files)) {
      const repoRel = repoRelative(opts.repoRoot, path.resolve(plan.pkg.dir, file));
      for (const m of entry.mutants) {
        mutants.push({
          id: `${repoRel}#${plan.lane.name}#${m.id}`,
          file: repoRel,
          lane: plan.lane.name,
          mutator: m.mutatorName,
          start: m.location.start,
          end: m.location.end,
          replacement: m.replacement ?? '',
          status: m.status,
          statusReason: m.statusReason ?? '',
          coveredBy: m.coveredBy?.length ?? 0,
          isStatic: m.static ?? false,
          killedBy: m.killedBy ?? [],
        });
      }
    }
    const testCount = Object.values(report.testFiles ?? {}).reduce((n, f) => n + f.tests.length, 0);
    return { pkg: plan.pkg, mutants, testCount, durationMs, artifacts: { config: configPath, report: reportPath, log: logPath, shim: shimPath } };
  }
}

/**
 * Stryker matches `mutate` entries as globs and turns backslashes into slashes, so `[id]` route
 * folders are escaped with bracket classes (`[[]id[]]`). Exported for its unit test.
 */
export function mutatePatterns(file: string, ranges: readonly Range[] | 'whole'): string[] {
  const escaped = escapeGlob(file);
  return ranges === 'whole' ? [escaped] : ranges.map((r) => `${escaped}:${LineRange.format(r)}`);
}

/**
 * The test names and assertion messages Stryker prints after "One or more tests failed in the
 * initial test run:", up to the next timestamped log line. Undefined when the dry run passed.
 */
export function dryRunFailures(logText: string): string | undefined {
  const lines = logText.split('\n');
  const start = lines.findIndex((l) => /tests failed in the initial test run|initial test run failed/i.test(l));
  if (start < 0) return undefined;
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\d\d:\d\d:\d\d \(\d+\)/.test(line.trim()) || /^\s*at /.test(line)) break;
    if (line.trim()) out.push(line.trim());
  }
  return out.slice(0, 12).join('\n');
}

function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // already gone
  }
}

function strykerBin(): string {
  const pkgJson = createRequire(import.meta.url).resolve('@stryker-mutator/core/package.json');
  const bin = (JSON.parse(readFileSync(pkgJson, 'utf8')) as { bin: Record<string, string> | string }).bin;
  const relBin = typeof bin === 'string' ? bin : (bin['stryker'] ?? Object.values(bin)[0] ?? 'bin/stryker.js');
  return path.join(path.dirname(pkgJson), relBin);
}
