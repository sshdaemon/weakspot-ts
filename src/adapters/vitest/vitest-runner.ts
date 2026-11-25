import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Package } from '../../change/types.ts';
import type { CoverageRunOptions, RunOptions, RunResult, ShimOptions, TestRunner } from '../../ports/test-runner.ts';

/**
 * Vitest behind the TestRunner port. The shim imports the package's own config statically, so
 * Vitest's config bundler resolves that file's imports from the package, then narrows root and
 * include and rebases aliases that point into the package onto the new root (the engine's
 * sandbox), so specs load the instrumented copies rather than the real tree. A lane's per-worker
 * env goes in a sibling module imported first, since a static import runs before the shim's body.
 */
export class VitestRunner implements TestRunner {
  readonly name = 'vitest';
  private readonly extra: Record<string, unknown>;

  constructor(extra: Record<string, unknown> = {}) {
    this.extra = extra;
  }

  /** `vitest.config.*`, `vite.config.*` and named variants such as `vitest.e2e.config.mts`. */
  detect(pkg: Package): boolean {
    return /(^|\/)vite(st)?[^/]*\.config\.[cm]?[jt]s$/.test(pkg.testConfig);
  }

  writeShim(pkg: Package, opts: ShimOptions, outPath: string): string {
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(path.join(path.dirname(outPath), ENV_MODULE), envSource(opts.env ?? {}, opts.workerIdVariable, opts.workerOffset ?? 0));
    writeFileSync(outPath, shimSource(pkg, opts));
    return outPath;
  }

  engineConfig(shimPath: string): Record<string, unknown> {
    return { testRunner: 'vitest', vitest: { configFile: shimPath, related: false, ...this.extra } };
  }

  async recordCoverage(pkg: Package, opts: CoverageRunOptions): Promise<{ executed: Map<string, string[]>; result: RunResult }> {
    mkdirSync(opts.workDir, { recursive: true });
    const shimPath = path.join(opts.workDir, 'vitest.map.shim.mts');
    const outFile = path.join(opts.workDir, 'executed.json');
    rmSync(outFile, { force: true });
    // One worker in the main process's env, so `{worker}` is honestly 0: the config, which sets the env, loads only there.
    writeFileSync(path.join(opts.workDir, ENV_MODULE), envSource(opts.env, undefined));
    writeFileSync(shimPath, shimSource(pkg, { root: pkg.dir, include: undefined, coverageProvider: MAP_PROVIDER }));
    // A map run takes as long as the suite: Vitest's own test and hook timeouts apply, and Ctrl-C stops it.
    const result = await this.run(pkg, shimPath, pkg.dir, Number.POSITIVE_INFINITY, { env: { WEAKSPOT_MAP_OUT: outFile }, ...(opts.signal ? { signal: opts.signal } : {}) });
    const executed = new Map<string, string[]>();
    if (existsSync(outFile)) {
      for (const [spec, modules] of Object.entries(JSON.parse(readFileSync(outFile, 'utf8')) as Record<string, string[]>)) executed.set(spec, modules);
    }
    return { executed, result };
  }

  async run(pkg: Package, shimPath: string, cwd: string, timeoutMs: number, opts: RunOptions = {}): Promise<RunResult> {
    const bin = vitestBin(pkg.dir);
    const outFile = path.join(path.dirname(shimPath), `${path.basename(shimPath).replace(/\.[cm]?[jt]s$/, '')}-run.json`);
    // A result left by an earlier run would read as this one's when the runner dies before writing.
    rmSync(outFile, { force: true });
    const started = Date.now();
    const output = await new Promise<{ code: number | null; text: string; timedOut: boolean }>((resolve, reject) => {
      const child = spawn(process.execPath, [bin, 'run', '--config', shimPath, '--root', cwd, '--reporter', 'json', '--outputFile', outFile], {
        cwd,
        env: { ...process.env, ...opts.env, CI: 'true' },
        detached: true,
      });
      let text = '';
      let timedOut = false;
      const onAbort = () => killGroup(child.pid);
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      if (opts.signal?.aborted) onAbort();
      child.stdout.on('data', (d) => (text += d));
      child.stderr.on('data', (d) => (text += d));
      // No limit at all for a non-finite one: setTimeout would read Infinity as one millisecond.
      const timer = Number.isFinite(timeoutMs)
        ? setTimeout(() => {
            timedOut = true;
            killGroup(child.pid);
          }, timeoutMs)
        : undefined;
      child.on('error', (err) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        resolve({ code, text, timedOut });
      });
    });
    const json = readReport(outFile);
    const passed = json.numPassedTests ?? 0;
    const failed = json.numFailedTests ?? 0;
    const failedSuites = json.numFailedTestSuites ?? 0;
    const failedFiles = failedFilesOf({ failed, failedSuites, code: output.code, timedOut: output.timedOut });
    return { passed, failed, failedFiles, timedOut: output.timedOut, durationMs: Date.now() - started, output: output.text };
  }
}

/** Vitest's JSON report; none when the run died before writing it, or was killed while writing it. */
function readReport(file: string): { numPassedTests?: number; numFailedTests?: number; numFailedTestSuites?: number } {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as { numPassedTests?: number; numFailedTests?: number; numFailedTestSuites?: number };
  } catch {
    return {};
  }
}

/**
 * Spec files that failed with no failing test: a file did not load, a hook threw, an error went unhandled.
 * A crash can leave no JSON, so a non-zero exit that is not a timeout counts as one at least.
 */
export function failedFilesOf(r: { failed: number; failedSuites: number; code: number | null; timedOut: boolean }): number {
  if (r.failed > 0 || r.timedOut) return 0;
  if (r.failedSuites > 0) return r.failedSuites;
  return r.code === 0 ? 0 : 1;
}

const ENV_MODULE = 'weakspot-env.mjs';

const MAP_PROVIDER = path.join(import.meta.dirname, 'map-provider.ts');

/**
 * The module the shim imports first: sets the lane's env with `{worker}` filled in from the
 * engine's worker id plus the run's offset for this engine process.
 */
export function envSource(env: Readonly<Record<string, string>>, workerIdVariable: string | undefined, workerOffset = 0): string {
  const id = workerIdVariable ? `Number(process.env[${JSON.stringify(workerIdVariable)}] ?? '0')` : `0`;
  const worker = `String(${workerOffset} + ${id})`;
  const lines = Object.entries(env).map(([k, v]) => `process.env[${JSON.stringify(k)}] = ${JSON.stringify(v)}.split('{worker}').join(worker);`);
  return `// generated by weakspot: per-worker environment, loaded before the package's config\nconst worker = ${worker};\n${lines.join('\n')}\n`;
}

/**
 * Source of the generated config. Exported so tests can check what it does to a config shape.
 * `globalSetup` is kept in the real package: it runs in the runner's main process, before any spec,
 * and typically prepares external state, so it never needs the instrumented copy and may reach
 * outside the package by relative path. A bare specifier the package can resolve is a module and stays.
 */
export function shimSource(pkg: Package, opts: ShimOptions & { readonly coverageProvider?: string }): string {
  const configUrl = pathToFileURL(pkg.testConfig).href;
  const root = opts.root === 'cwd' ? 'process.cwd()' : JSON.stringify(opts.root);
  return `// generated by weakspot: wraps the package's vitest config, narrows root and include
import './${ENV_MODULE}';
import { createRequire } from 'node:module';
import path from 'node:path';
import raw from ${JSON.stringify(configUrl)};
const PKG = ${JSON.stringify(pkg.dir)};
const root = ${root};
const base = typeof raw === 'function' ? await raw({ mode: 'test', command: 'serve' }) : await raw;
if (!base || typeof base !== 'object') throw new Error('weakspot: ' + ${JSON.stringify(pkg.testConfig)} + ' has no config object as default export');
const rebase = (p) => (typeof p === 'string' && (p === PKG || p.startsWith(PKG + '/')) ? root + p.slice(PKG.length) : p);
const rebaseAlias = (a) => {
  if (Array.isArray(a)) return a.map((e) => (e && typeof e === 'object' ? { ...e, replacement: rebase(e.replacement) } : e));
  if (a && typeof a === 'object') return Object.fromEntries(Object.entries(a).map(([k, v]) => [k, rebase(v)]));
  return a;
};
const { dir, root: _testRoot, projects, workspace, alias: testAlias, globalSetup, ...test } = base.test ?? {};
const cfg = { ...base, root };
if (base.resolve?.alias) cfg.resolve = { ...base.resolve, alias: rebaseAlias(base.resolve.alias) };
cfg.test = { ...test, root, ${opts.include ? `include: ${JSON.stringify(opts.include)}, ` : ''}coverage: ${coverageSource(opts.coverageProvider)}, cache: false, fsModuleCache: false${opts.coverageProvider ? ', isolate: true, fileParallelism: false' : ''} };
if (testAlias) cfg.test.alias = rebaseAlias(testAlias);
const isModule = (p) => { try { createRequire(PKG + '/noop.js').resolve(p); return true; } catch { return false; } };
const inPackage = (p) => (typeof p !== 'string' || path.isAbsolute(p) || (!/^\\.\\.?(\\/|$)/.test(p) && isModule(p)) ? p : path.resolve(PKG, p));
if (globalSetup) cfg.test.globalSetup = Array.isArray(globalSetup) ? globalSetup.map(inPackage) : inPackage(globalSetup);
export default cfg;
`;
}

/** Off, or the map provider: it must report even when a spec fails, since a failing spec still ran code. */
function coverageSource(provider: string | undefined): string {
  if (!provider) return '{ enabled: false }';
  return `{ enabled: true, provider: 'custom', customProviderModule: ${JSON.stringify(provider)}, reportOnFailure: true, clean: false }`;
}

function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGTERM');
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }, 2000).unref();
  } catch {
    // already gone
  }
}

/** The package's own vitest when it has one, else the copy bundled with the tool. */
function vitestBin(pkgDir: string): string {
  for (const from of [path.join(pkgDir, 'noop.js'), import.meta.url]) {
    try {
      const pkgJson = createRequire(from).resolve('vitest/package.json');
      const bin = (JSON.parse(readFileSync(pkgJson, 'utf8')) as { bin: Record<string, string> | string }).bin;
      const rel = typeof bin === 'string' ? bin : (bin['vitest'] ?? Object.values(bin)[0] ?? 'vitest.mjs');
      return path.join(path.dirname(pkgJson), rel);
    } catch {
      // try the next location
    }
  }
  throw new Error('vitest not found in the package or in weakspot');
}
