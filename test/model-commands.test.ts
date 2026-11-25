import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { TsPlaceholderFinder } from '../src/adapters/ts/placeholder-finder.ts';
import type { Package } from '../src/change/types.ts';
import { validate } from '../src/cli/config.ts';
import { readMutantEntries, readPlaceholders, runMutants, type MutantsCommandInput } from '../src/cli/mutants-command.ts';
import { exitCodeFor } from '../src/cli/exit-codes.ts';
import { TestsFailBeforeMutationError } from '../src/mutation/errors.ts';
import { MutantsFileError } from '../src/mutation/validate.ts';
import { InterruptedError, UsageError, type PipelineInput } from '../src/cli/pipeline.ts';
import { propose } from '../src/cli/propose-command.ts';
import type { CachedMutant, PlaceholderFile } from '../src/mutation/model.ts';
import type { MutantCache } from '../src/ports/mutant-cache.ts';
import type { Sandbox, SandboxFactory } from '../src/ports/sandbox.ts';
import type { TestRunner } from '../src/ports/test-runner.ts';
import { emptyReport } from '../src/report/merge.ts';
import { survivorId } from '../src/report/suppressions.ts';
import type { AcceptedEntry } from '../src/report/suppressions.ts';
import { REPORT_SCHEMA_VERSION, type Report } from '../src/report/types.ts';

let repo: string;
let out: string;
let app: Package;
const SOURCE = "export function allowed(role: string, n: number) {\n  if (role === 'admin') return n > 0;\n  return false;\n}\n";

beforeEach(() => {
  repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'weakspot-model-repo-')));
  out = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'weakspot-model-out-')));
  mkdirSync(path.join(repo, 'app/src'), { recursive: true });
  writeFileSync(path.join(repo, 'app/vitest.config.ts'), '');
  writeFileSync(path.join(repo, 'app/src/access.ts'), SOURCE);
  writeFileSync(path.join(repo, 'app/src/plain.ts'), 'export type T = string;\n');
  writeFileSync(path.join(repo, 'app/src/orphan.ts'), 'export const o = (n: number) => n > 1;\n');
  app = { dir: path.join(repo, 'app'), name: 'app', testConfig: path.join(repo, 'app/vitest.config.ts') };
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

class MemoryCache implements MutantCache {
  readonly entries = new Map<string, readonly CachedMutant[]>();
  readonly puts: Map<string, readonly CachedMutant[]>[] = [];
  get(_repo: string, id: string) {
    return this.entries.get(id);
  }
  put(_repo: string, entries: ReadonlyMap<string, readonly CachedMutant[]>) {
    this.puts.push(new Map(entries));
    for (const [k, v] of entries) this.entries.set(k, v);
  }
}

const config = validate({}, 'test');

function proposeInput(cache: MutantCache, over: Partial<PipelineInput> = {}) {
  const logs: string[] = [];
  const runner: TestRunner = { name: 'fake', detect: () => true, writeShim: () => '', engineConfig: () => ({}), run: () => Promise.reject(new Error('propose runs no tests')) };
  const input = {
    changed: ['app/src/access.ts', 'app/src/plain.ts', 'app/src/orphan.ts'].map((p) => ({ path: p, status: 'modified' as const, ranges: [{ start: 1, end: 3 }] })),
    change: { kind: 'diff' as const, detail: 'main' },
    specs: [],
    repoRoot: repo,
    out,
    config,
    runner,
    engine: { name: 'fake', workerIdVariable: 'W', run: () => Promise.reject(new Error('propose runs no engine')) },
    specFinder: { find: (_r: string, _p: Package, file: string) => ({ file, specs: file.endsWith('orphan.ts') ? [] : ['app/src/access.test.ts'], how: 'imports' as const }) },
    packages: { repoRoot: () => repo, packageOf: () => app },
    log: (line: string) => logs.push(line),
    commandLine: 'weakspot propose',
    version: 't',
    ...over,
  };
  return { input: { ...input, finder: new TsPlaceholderFinder(), cache: { store: cache, repoKey: 'org/r' }, instructions: 'the prompt' }, logs };
}

test('propose: placeholders on the changed lines of files with specs, the runs to use, cached marks, an excerpt', () => {
  const cache = new MemoryCache();
  const first = propose(proposeInput(cache).input).file;
  const cond = first.placeholders.find((p) => p.original === "role === 'admin'")!;
  cache.entries.set(cond.id, [{ replacement: "role !== 'admin'", because: 'only non-admins pass' }]);
  const { input, logs } = proposeInput(cache);
  const { file, path: written } = propose(input);
  assert.equal(written, path.join(out, 'placeholders.json'));
  assert.deepEqual(JSON.parse(readFileSync(written, 'utf8')), file);
  assert.deepEqual([file.kind, file.schemaVersion, file.repo, file.instructions, file.command], ['placeholders', 1, repo, 'the prompt', 'weakspot propose']);
  assert.deepEqual(file.files.map((f) => [f.path, f.runs, f.excerpt.startLine]), [
    ['app/src/access.ts', [{ lane: 'unit', package: { name: 'app', dir: 'app', testConfig: 'app/vitest.config.ts' }, specs: ['app/src/access.test.ts'] }], 1],
  ]);
  assert.deepEqual(file.placeholders.map((p) => [p.kind, p.original, Boolean(p.cached)]), [
    ['condition', "role === 'admin'", true],
    ['returnExpression', 'n > 0', false],
    ['returnExpression', 'false', false],
  ]);
  assert.ok(logs.includes('app/src/plain.ts: no placeholder on the changed lines'));
  assert.ok(logs.some((l) => /untested: app\/src\/orphan\.ts/.test(l)));
  assert.throws(() => propose(proposeInput(cache, { out: path.join(repo, 'o') }).input), UsageError);
});

/** The runner kills a mutant whose text holds `kill`, and records what each run saw. */
function runInput(placeholders: PlaceholderFile, entries: unknown[], over: Partial<MutantsCommandInput> = {}) {
  const writes = new Map<string, string>();
  const seen: string[] = [];
  const sandboxes: SandboxFactory = {
    create: (_pkgDir, at): Sandbox => ({ dir: at, write: (f, t) => writes.set(`${at}/${f}`, t), restore: (f) => writes.delete(`${at}/${f}`), dispose: () => {} }),
  };
  const runner: TestRunner = {
    name: 'fake',
    detect: () => true,
    engineConfig: () => ({}),
    writeShim: (_p, _o, outPath) => outPath,
    run: (_pkg, _shim, cwd) => {
      const text = writes.get(`${cwd}/src/access.ts`);
      const canary = text?.includes('sandbox copy was loaded') ?? false;
      if (text !== undefined && !canary) seen.push(text);
      return Promise.resolve({ passed: 2, failed: text?.includes('kill') ? 1 : 0, failedFiles: canary ? 1 : 0, timedOut: false, durationMs: 10, output: '' });
    },
  };
  const logs: string[] = [];
  const cache = new MemoryCache();
  const input: MutantsCommandInput = {
    placeholders,
    placeholdersPath: path.join(out, 'placeholders.json'),
    mutantsPath: path.join(out, 'answers.json'),
    entries,
    out,
    config,
    runner,
    sandboxes,
    finder: new TsPlaceholderFinder(),
    cache: { store: cache, repoKey: 'org/r' },
    log: (line) => logs.push(line),
    commandLine: 'weakspot run --mutants answers.json',
    version: 't',
    ...over,
  };
  return { input, seen, logs, cache };
}

const answer = (placeholder: string, replacement: string, because = 'it differs') => ({ placeholder, replacement, because });

test('run --mutants: valid answers and unanswered cached ones run, results merge into the report in --out, record and rejections written', async () => {
  const proposeCache = new MemoryCache();
  const first = propose(proposeInput(proposeCache).input).file;
  const [cond, ret] = first.placeholders;
  proposeCache.entries.set(ret!.id, [{ replacement: 'n >= 0', because: 'cached reading' }]);
  const placeholders = propose(proposeInput(proposeCache).input).file;
  const operatorReport: Report = { ...emptyReport({ version: 't', repo, command: 'weakspot diff', change: { kind: 'diff', detail: 'main' } }), untested: ['app/src/orphan.ts'] };
  writeFileSync(path.join(out, 'report.json'), JSON.stringify(operatorReport));
  const { input, seen, cache } = runInput(placeholders, [answer(cond!.id, "role === 'kill'"), answer(cond!.id, "role !== 'admin'", 'only non-admins pass'), answer(cond!.id, 'role ===')]);
  const { report, rejected } = await runMutants(input);

  assert.equal(seen.length, 3);
  assert.ok(seen.some((t) => t.includes("if (role !== 'admin') return n > 0;")) && seen.some((t) => t.includes('return n >= 0;')));
  assert.deepEqual(report.mutants.map((m) => [m.replacement, m.status, m.mutator]), [
    ["role === 'kill'", 'Killed', 'model'],
    ["role !== 'admin'", 'Survived', 'model'],
    ['n >= 0', 'Survived', 'model'],
  ]);
  assert.deepEqual(report.findings.map((f) => f.kind), ['weakAssertion', 'weakAssertion']);
  assert.deepEqual([report.untested, report.command], [['app/src/orphan.ts'], 'weakspot diff'], 'the earlier run\'s results stay');
  assert.deepEqual(report.packages.map((p) => [p.lane, p.model, p.counts]), [['unit', true, { Killed: 1, Survived: 2 }]]);
  assert.deepEqual(rejected.map((r) => r.replacement), ['role ===']);
  assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8')), report);
  assert.match(readFileSync(path.join(out, 'report.md'), 'utf8'), /## Rejected model mutants/);
  assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'rejected.json'), 'utf8')), { rejected });
  assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'mutants.json'), 'utf8')).mutants.map((m: { replacement: string }) => m.replacement), ["role === 'kill'", "role !== 'admin'", 'n >= 0']);
  assert.deepEqual(report.model!.mutants, path.join(out, 'mutants.json'));
  assert.deepEqual(cache.puts.map((m) => Array.from(m.entries())), [[[cond!.id, [{ replacement: "role === 'kill'", because: 'it differs' }, { replacement: "role !== 'admin'", because: 'only non-admins pass' }]]]], 'only the author\'s own answers go to the cache');
});

test('run --mutants: another repo\'s report in --out is replaced, the placeholders file is copied in, accepted survivors are not findings', async () => {
  const placeholders = propose(proposeInput(new MemoryCache()).input).file;
  const elsewhere = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'weakspot-model-ph-')));
  try {
    writeFileSync(path.join(elsewhere, 'placeholders.json'), JSON.stringify(placeholders));
    rmSync(path.join(out, 'placeholders.json'));
    writeFileSync(path.join(out, 'report.json'), JSON.stringify(emptyReport({ version: 't', repo: '/other', command: 'x', change: { kind: 'diff', detail: 'main' } })));
    const cond = placeholders.placeholders[0]!;
    const accepted: AcceptedEntry[] = [];
    const store = { list: () => accepted, accept: () => {}, revoke: () => false };
    const { input, logs } = runInput(placeholders, [answer(cond.id, 'true')], { placeholdersPath: path.join(elsewhere, 'placeholders.json'), suppressions: { store, repoKey: 'org/r' } });
    const firstRun = await runMutants(input);
    assert.ok(logs.some((l) => /is for another repo or report schema/.test(l)));
    assert.equal(firstRun.report.command, 'weakspot propose');
    assert.ok(existsSync(path.join(out, 'placeholders.json')));
    accepted.push({ repo: 'org/r', id: survivorId(firstRun.report.mutants[0]!), reason: 'equivalent', date: 'd' });
    const second = await runMutants(runInput(placeholders, [answer(cond.id, 'true')], { suppressions: { store, repoKey: 'org/r' } }).input);
    assert.deepEqual([second.report.findings.length, second.report.accepted.map((a) => a.reason)], [0, ['equivalent']]);
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test.each<[string, Partial<Report>]>([
  ['a newer report schema', { schemaVersion: REPORT_SCHEMA_VERSION + 1 }],
  ['another tool', { tool: 'other' as Report['tool'] }],
  ['broken JSON', {}],
])('run --mutants does not extend a report.json in --out from %s', async (name, over) => {
  const placeholders = propose(proposeInput(new MemoryCache()).input).file;
  const theirs = { ...emptyReport({ version: 't', repo, command: 'theirs', change: { kind: 'diff', detail: 'main' } }), untested: ['app/src/orphan.ts'], ...over };
  writeFileSync(path.join(out, 'report.json'), name === 'broken JSON' ? '{ nope' : JSON.stringify(theirs));
  const { input, logs } = runInput(placeholders, [answer(placeholders.placeholders[0]!.id, 'true')]);
  const { report } = await runMutants(input);
  assert.deepEqual([report.command, report.untested, report.schemaVersion], ['weakspot propose', [], REPORT_SCHEMA_VERSION]);
  assert.ok(logs.some((l) => /writing a report with the model mutants only/.test(l)));
});

test('run --mutants: a lane the config lost, a missing test config, --out in the repo and an abort are errors', async () => {
  const placeholders = propose(proposeInput(new MemoryCache()).input).file;
  const one = [answer(placeholders.placeholders[0]!.id, 'true')];
  await assert.rejects(runMutants(runInput(placeholders, one, { config: { ...config, lanes: [] } }).input), (e: unknown) => e instanceof UsageError && /no longer has; run propose again/.test(e.message));
  await assert.rejects(runMutants(runInput(placeholders, one, { out: path.join(repo, 'o') }).input), UsageError);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runMutants(runInput(placeholders, one, { signal: controller.signal }).input), InterruptedError);
  rmSync(path.join(repo, 'app/vitest.config.ts'));
  await assert.rejects(runMutants(runInput(placeholders, one).input), (e: unknown) => e instanceof UsageError && /app\/vitest\.config\.ts no longer exists/.test(e.message));
});

test('run --mutants with nothing valid runs nothing and still reports the rejections', async () => {
  const placeholders = propose(proposeInput(new MemoryCache()).input).file;
  const { input, seen } = runInput(placeholders, [answer('nope', 'x')]);
  const { report } = await runMutants(input);
  assert.deepEqual([seen, report.packages, report.model!.rejected.length, report.findings], [[], [], 1, []]);
});

function writeOut(name: string, text: string): string {
  writeFileSync(path.join(out, name), text);
  return path.join(out, name);
}

test('a placeholders or mutants file that is missing, not JSON or the wrong shape is a usage error', () => {
  const bad = [
    writeOut('missing-kind.json', JSON.stringify({ schemaVersion: 1, repo: '/r', files: [], placeholders: [] })),
    writeOut('old-schema.json', JSON.stringify({ kind: 'placeholders', schemaVersion: 0, repo: '/r', files: [], placeholders: [] })),
    writeOut('no-repo.json', JSON.stringify({ kind: 'placeholders', schemaVersion: 1, files: [], placeholders: [] })),
    writeOut('files-object.json', JSON.stringify({ kind: 'placeholders', schemaVersion: 1, repo: '/r', files: {}, placeholders: [] })),
    writeOut('placeholders-object.json', JSON.stringify({ kind: 'placeholders', schemaVersion: 1, repo: '/r', files: [], placeholders: {} })),
  ];
  for (const f of bad) assert.throws(() => readPlaceholders(f), (e: unknown) => e instanceof MutantsFileError && exitCodeFor(e) === 2 && e.message.includes('not a placeholders file'), f);
  assert.equal(readPlaceholders(writeOut('ok.json', JSON.stringify({ kind: 'placeholders', schemaVersion: 1, repo: '/r', files: [], placeholders: [] }))).repo, '/r');
  assert.throws(() => readMutantEntries(path.join(out, 'nope.json')), /nope\.json does not exist/);
  assert.throws(() => readMutantEntries(writeOut('broken.json', '{ "mutants": [')), /broken\.json: not valid JSON/);
  assert.throws(() => readMutantEntries(writeOut('shape.json', '{ "answers": [] }')), MutantsFileError);
  assert.deepEqual(readMutantEntries(writeOut('fine.json', '{ "mutants": [1] }')), [1]);
});

test('a placeholder whose file has no entry in files is a usage error, not a crash', async () => {
  const placeholders = propose(proposeInput(new MemoryCache()).input).file;
  await assert.rejects(runMutants(runInput({ ...placeholders, files: [] }, [answer(placeholders.placeholders[0]!.id, 'true')]).input), (e: unknown) => e instanceof MutantsFileError && /has no entry in files/.test(e.message));
});

test('the first job to fail is the error reported, and it stops the jobs still running', async () => {
  const placeholders = propose(proposeInput(new MemoryCache()).input).file;
  const [target] = placeholders.files;
  const e2eRun = { ...target!.runs[0]!, lane: 'e2e', package: { ...target!.runs[0]!.package, testConfig: 'app/vitest-e2e.config.ts' } };
  writeFileSync(path.join(repo, 'app/vitest-e2e.config.ts'), '');
  const twoLanes: PlaceholderFile = { ...placeholders, files: [{ ...target!, runs: [...target!.runs, e2eRun] }] };
  const withE2e = validate({ lanes: { e2e: { config: 'vitest-e2e.config.ts', specs: 'imports' } } }, 'test');
  const { input } = runInput(twoLanes, [answer(placeholders.placeholders[0]!.id, 'true')], { config: withE2e });
  let unitSawAbort = false;
  input.runner.run = (_pkg, _shim, cwd, _t, opts) => {
    if (cwd.includes('-e2e')) return Promise.resolve({ passed: 0, failed: 1, failedFiles: 0, timedOut: false, durationMs: 1, output: 'e2e red' });
    return new Promise((resolve) =>
      opts!.signal!.addEventListener('abort', () => {
        unitSawAbort = true;
        resolve({ passed: 0, failed: 0, failedFiles: 0, timedOut: false, durationMs: 1, output: 'stopped' });
      }),
    );
  };
  await assert.rejects(runMutants(input), (e: unknown) => e instanceof TestsFailBeforeMutationError && /e2e red/.test(e.message));
  assert.equal(unitSawAbort, true);
});

test('propose keeps only the placeholders on changed lines, numbered across the whole file first', () => {
  writeFileSync(path.join(repo, 'app/src/twice.ts'), 'export function f(x: number) {\n  if (x > 0) return 1;\n  if (x > 0) return 2;\n  return 0;\n}\n');
  const { input } = proposeInput(new MemoryCache(), { changed: [{ path: 'app/src/twice.ts', status: 'modified', ranges: [{ start: 3, end: 3 }] }] });
  const { file } = propose(input);
  assert.deepEqual(file.placeholders.map((p) => [p.start.line, p.kind, p.original]), [[3, 'condition', 'x > 0'], [3, 'returnExpression', '2']]);
  assert.match(file.placeholders[0]!.id, /^app\/src\/twice\.ts#condition#[0-9a-f]{12}~2$/);
  assert.doesNotMatch(file.placeholders[1]!.id, /~/);
});

const specOf = (file: string) => file.replace(/\.ts$/, '.test.ts');

/** Two files in app, one in lib; the e2e lane takes every file and has a prepare that leaves a mark per run. */
function twoPackages() {
  mkdirSync(path.join(repo, 'lib/src'), { recursive: true });
  for (const f of ['lib/vitest.config.ts', 'app/vitest-e2e.config.ts', 'lib/vitest-e2e.config.ts']) writeFileSync(path.join(repo, f), '');
  writeFileSync(path.join(repo, 'app/src/twice.ts'), 'export const t = (x: number) => x > 0;\n');
  writeFileSync(path.join(repo, 'lib/src/l.ts'), 'export const l = (x: number) => x > 1;\n');
  const lib: Package = { dir: path.join(repo, 'lib'), name: 'lib', testConfig: path.join(repo, 'lib/vitest.config.ts') };
  const withE2e = validate({ lanes: { e2e: { config: 'vitest-e2e.config.ts', specs: 'imports', prepare: 'echo run >> prepared.txt' } } }, 'test');
  const { input } = proposeInput(new MemoryCache(), {
    changed: ['app/src/access.ts', 'app/src/twice.ts', 'lib/src/l.ts'].map((p) => ({ path: p, status: 'modified' as const, ranges: 'whole' as const })),
    config: withE2e,
    laneSelection: ['e2e'],
    lanes: [{ config: withE2e.lanes[1]!, finder: { find: (_r, _p, file) => ({ file, specs: [specOf(file)], how: 'imports' }) } }],
    packages: { repoRoot: () => repo, packageOf: (_root, abs) => (abs.startsWith(`${lib.dir}/`) ? lib : app) },
  });
  const placeholders = propose(input).file;
  const answers = placeholders.placeholders.filter((p) => p.kind === 'condition' || (p.kind === 'returnExpression' && p.file !== 'app/src/access.ts')).map((p) => answer(p.id, 'true'));
  return { placeholders, answers, withE2e };
}

test('run --mutants: each file runs its own specs in its own package, and a lane prepares each package once', async () => {
  const { placeholders, answers, withE2e } = twoPackages();
  const { input } = runInput(placeholders, answers, { config: withE2e });
  const runs: string[] = [];
  const shims = new Map<string, readonly string[]>();
  input.runner.writeShim = (_p, opts, outPath) => {
    shims.set(outPath, opts.include ?? []);
    return outPath;
  };
  input.runner.run = (pkg, shim, cwd) => {
    if (path.basename(shim).startsWith('f')) runs.push(`${pkg.name} ${path.basename(path.dirname(path.dirname(cwd)))} ${shims.get(shim)!.join(',')}`);
    return Promise.resolve({ passed: 1, failed: 0, failedFiles: path.basename(shim).startsWith('canary') ? 1 : 0, timedOut: false, durationMs: 1, output: '' });
  };
  const { report } = await runMutants(input);
  assert.deepEqual([...new Set(runs)].toSorted(), ['app 1-e2e src/access.test.ts', 'app 1-e2e src/twice.test.ts', 'lib 2-e2e src/l.test.ts']);
  assert.deepEqual(report.mutants.map((m) => m.file).toSorted(), ['app/src/access.ts', 'app/src/twice.ts', 'lib/src/l.ts']);
  assert.deepEqual(['app', 'lib'].map((d) => readFileSync(path.join(repo, d, 'prepared.txt'), 'utf8')), ['run\n', 'run\n']);
});

test('run --mutants: Ctrl-C during one job reaches the runs of the others', async () => {
  const { placeholders, answers, withE2e } = twoPackages();
  const controller = new AbortController();
  const { input } = runInput(placeholders, answers, { config: withE2e, signal: controller.signal });
  let libSawAbort = false;
  input.runner.run = (pkg, shim, _cwd, _t, opts) => {
    if (pkg.name === 'app') setTimeout(() => controller.abort(), 20);
    const result = { passed: 1, failed: 0, failedFiles: path.basename(shim).startsWith('canary') ? 1 : 0, timedOut: false, durationMs: 1, output: '' };
    if (opts!.signal!.aborted) return Promise.resolve(result);
    return new Promise((resolve) =>
      opts!.signal!.addEventListener('abort', () => {
        if (pkg.name === 'lib') libSawAbort = true;
        resolve(result);
      }),
    );
  };
  await assert.rejects(runMutants(input), InterruptedError);
  assert.equal(libSawAbort, true);
});

test('propose leaves out sources mutated whole only because a changed spec imports them, and writes no wide marks', () => {
  writeFileSync(path.join(repo, 'app/src/twice.ts'), 'export const t = (xs: number[]) => xs.map((x) => x > 0);\n');
  const { input, logs } = proposeInput(new MemoryCache(), {
    changed: [
      { path: 'app/src/access.test.ts', status: 'modified', ranges: [{ start: 1, end: 1 }] },
      { path: 'app/src/twice.ts', status: 'modified', ranges: 'whole' },
    ],
    imports: { importsOf: () => [path.join(repo, 'app/src/access.ts')], importLines: () => new Set(), onlyImports: () => false },
  });
  const { file, path: written } = propose(input);
  assert.deepEqual(file.files.map((f) => f.path), ['app/src/twice.ts']);
  assert.ok(logs.includes('app/src/access.ts: not offered to the author; only its changed spec makes it a target'));
  assert.doesNotMatch(readFileSync(written, 'utf8'), /"wide"/);
});
