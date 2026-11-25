import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { DEFAULT_SPEC_PATTERNS } from '../src/change/spec-kind.ts';
import type { CoverageMap } from '../src/change/coverage-map.ts';
import type { Package } from '../src/change/types.ts';
import { validate } from '../src/cli/config.ts';
import { exitCodeFor } from '../src/cli/exit-codes.ts';
import { checkUsage } from '../src/cli/flags.ts';
import { MapFailedError, mapCommand, mapSummary, planMap, type MapCommandInput } from '../src/cli/map-command.ts';
import { InterruptedError, UsageError } from '../src/cli/pipeline.ts';
import { JestRunner } from '../src/adapters/jest/jest-runner.ts';
import { RunnerSet, UnsupportedByRunnerError } from '../src/adapters/runner-set.ts';
import { VitestRunner } from '../src/adapters/vitest/vitest-runner.ts';
import type { RunResult, TestRunner } from '../src/ports/test-runner.ts';
import { CoverageSpecFinder } from '../src/adapters/spec/coverage-spec-finder.ts';
import { FirstSpecFinder } from '../src/adapters/spec/first-spec-finder.ts';
import { laneFinder } from '../src/adapters/spec/lane-finder.ts';

let repo: string;
beforeEach(() => {
  repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'weakspot-mapcmd-')));
  for (const d of ['services/api', 'services/web']) mkdirSync(path.join(repo, d), { recursive: true });
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

const config = validate({ lanes: { e2e: { config: 'vitest-e2e.config.ts', specs: ['coverage', 'imports'], envPerWorker: { DB: 'db_{worker}' }, prepare: 'echo built >> prepared.txt' } } }, 'test');
const lane = config.lanes[1]!;
const NAMES = ['services/api', 'services/web'];
const ok: RunResult = { passed: 3, failed: 0, failedFiles: 0, timedOut: false, durationMs: 1, output: '' };

function input(over: Partial<MapCommandInput> & { results?: Record<string, Partial<RunResult>>; executed?: Record<string, Record<string, string[]>> } = {}) {
  const calls: string[] = [];
  const written: CoverageMap[] = [];
  const packages: Package[] = NAMES.map((name) => ({ dir: path.join(repo, name), name, testConfig: '' }));
  const runner: TestRunner = {
    name: 'fake',
    detect: () => true,
    writeShim: () => '',
    engineConfig: () => ({}),
    run: () => Promise.resolve(ok),
    recordCoverage: (pkg, opts) => {
      calls.push(`${pkg.name} ${path.relative(repo, opts.workDir)} ${JSON.stringify(opts.env)}`);
      const executed = over.executed?.[pkg.name] ?? { [`${pkg.dir}/test/a.e2e.ts`]: [`${pkg.dir}/src/a.ts`, `${pkg.dir}/test/a.e2e.ts`] };
      return Promise.resolve({ executed: new Map(Object.entries(executed)), result: { ...ok, ...over.results?.[pkg.name] } });
    },
  };
  const logs: string[] = [];
  const base: MapCommandInput = {
    repoRoot: repo,
    repoKey: 'org/app',
    lane,
    runner,
    store: {
      read: () => undefined,
      write: (m) => {
        written.push(m);
        return '/maps/org_app/e2e.json';
      },
    },
    patterns: DEFAULT_SPEC_PATTERNS,
    packages,
    head: 'h'.repeat(40),
    workDir: path.join(repo, '..', 'work'),
    log: (l) => logs.push(l),
    now: () => new Date('2026-11-25T00:00:00.000Z'),
    ...over,
  };
  return { base, calls, written, logs };
}

test('map: every package with the lane\'s config, prepared, its suite run with the lane env; one map of repo-relative sources', async () => {
  const { base, calls, written } = input();
  const done = await mapCommand(base);
  assert.deepEqual(calls.map((c) => c.split(' ').slice(0, 1).concat(c.split(' ').slice(2)).join(' ')), ['services/api {"DB":"db_{worker}"}', 'services/web {"DB":"db_{worker}"}']);
  assert.ok(calls.every((c) => c.split(' ')[1]!.endsWith(c.split(' ')[0]!)), 'a work folder per package');
  assert.deepEqual(done.map, {
    schemaVersion: 1,
    repo: 'org/app',
    lane: 'e2e',
    commit: 'h'.repeat(40),
    createdAt: '2026-11-25T00:00:00.000Z',
    packages: ['services/api', 'services/web'],
    specs: { 'services/api/test/a.e2e.ts': ['services/api/src/a.ts'], 'services/web/test/a.e2e.ts': ['services/web/src/a.ts'] },
  });
  assert.deepEqual([written, done.file, done.failing], [[done.map], '/maps/org_app/e2e.json', 0]);
  assert.deepEqual(['services/api', 'services/web'].map((d) => readFileSync(path.join(repo, d, 'prepared.txt'), 'utf8')), ['built\n', 'built\n']);
  assert.deepEqual([done.failed, 'missing' in done.map], [[], false], 'a complete map lists nothing missing');
  assert.equal(mapSummary({ ...done, failing: 2 }), '2 spec(s) in 2 package(s) ran 2 source file(s), 2 failing\nmap: /maps/org_app/e2e.json');
  assert.equal(mapSummary(done), '2 spec(s) in 2 package(s) ran 2 source file(s)\nmap: /maps/org_app/e2e.json');
});

test('map: failing specs still count, and are reported', async () => {
  const { base, logs } = input({ results: { 'services/web': { failed: 2, failedFiles: 1 } } });
  const done = await mapCommand(base);
  assert.equal(done.failing, 3);
  assert.ok(logs.includes('e2e services/web: 3 failing test(s) or spec file(s); what they ran is in the map all the same'));
  assert.deepEqual(Object.keys(done.map.specs), ['services/api/test/a.e2e.ts', 'services/web/test/a.e2e.ts']);
});

test('map: a package whose suite records nothing is left out and named; the others still make the map', async () => {
  const crashed = input({ executed: { 'services/web': {} }, results: { 'services/web': { passed: 0, output: 'a\nError: boom' } } });
  const done = await mapCommand(crashed.base);
  assert.deepEqual([done.map.packages, done.map.missing, Object.keys(done.map.specs), done.failed], [['services/api'], ['services/web'], ['services/api/test/a.e2e.ts'], [{ name: 'services/web', dir: 'services/web', why: 'a\nError: boom' }]]);
  assert.deepEqual(crashed.written, [done.map]);
  assert.ok(crashed.logs.includes('e2e services/web: recorded no spec, left out of the map: a\nError: boom'));
  assert.equal(mapSummary(done), '1 spec(s) in 1 package(s) ran 1 source file(s)\nleft out, recorded nothing: services/web\nmap: /maps/org_app/e2e.json');
});

test('map: when no package records anything there is no map (exit 3), and each one is named', async () => {
  const none = input({ executed: { 'services/api': {}, 'services/web': {} }, results: { 'services/api': { output: '' }, 'services/web': { output: 'boom' } } });
  await assert.rejects(mapCommand(none.base), (e: unknown) => e instanceof MapFailedError && exitCodeFor(e) === 3 && e.message === 'no e2e suite recorded a spec: services/api: no output; services/web: boom');
  assert.deepEqual(none.written, []);
});

test('map: no package with the config, a runner that cannot record, and an abort are refused', async () => {
  await assert.rejects(mapCommand(input({ packages: [] }).base), (e: unknown) => e instanceof UsageError && /no package in .* has vitest-e2e\.config\.ts, the e2e lane's config/.test(e.message));
  const { base } = input();
  const { recordCoverage: _r, ...plain } = base.runner;
  await assert.rejects(mapCommand({ ...base, runner: plain }), (e: unknown) => e instanceof UnsupportedByRunnerError && exitCodeFor(e) === 2 && e.message === 'the fake runner cannot record what each spec ran, so no coverage map can be made');
  const mixed = input();
  const partial = { ...mixed.base.runner, coverageRefusal: (p: Package) => (p.name === 'services/api' ? undefined : `${p.name} says no`) };
  await assert.rejects(mapCommand({ ...mixed.base, runner: partial }), (e: unknown) => e instanceof UnsupportedByRunnerError && e.message === 'services/web says no');
  assert.deepEqual([mixed.logs, mixed.calls], [[], []], 'refused before any prepare or suite');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(mapCommand({ ...input().base, signal: controller.signal }), InterruptedError);
});

test('map: with the real runners, a Jest package or an unknown config refuses the whole map before any prepare runs', async () => {
  const runner = new RunnerSet([new VitestRunner(), new JestRunner()]);
  const packages: Package[] = [
    { dir: path.join(repo, 'services/api'), name: 'services/api', testConfig: path.join(repo, 'services/api/vitest-e2e.config.ts') },
    { dir: path.join(repo, 'services/web'), name: 'services/web', testConfig: path.join(repo, 'services/web/jest.config.ts') },
    { dir: path.join(repo, 'services/docs'), name: 'services/docs', testConfig: path.join(repo, 'services/docs/vitest.config.e2e.ts') },
  ];
  await assert.rejects(
    mapCommand({ ...input().base, runner, packages }),
    (e: unknown) => e instanceof UnsupportedByRunnerError && exitCodeFor(e) === 2 && e.message === 'services/web runs its tests with jest, which cannot record what each spec ran; a coverage map needs a vitest package; services/docs has vitest.config.e2e.ts, which is not a vitest or jest config',
  );
  assert.deepEqual(packages.map((p) => existsSync(path.join(p.dir, 'prepared.txt'))), [false, false, false]);
});

test('map usage: one lane name, and only --repo, --out and --quiet', () => {
  assert.doesNotThrow(() => checkUsage('map', ['e2e'], { repo: '.', out: '/tmp/x', quiet: true }));
  assert.throws(() => checkUsage('map', [], {}), /map: give one lane name/);
  assert.throws(() => checkUsage('map', ['e2e', 'unit'], {}), /give one lane name/);
  assert.throws(() => checkUsage('map', ['e2e'], { base: 'main', lanes: 'all' }), /map: --base, --lanes do not apply/);
});

test('config: "coverage" is a spec source for a lane, still not for the unit lane', () => {
  assert.deepEqual(lane.specs, ['coverage', 'imports']);
  assert.throws(() => validate({ lanes: { unit: { specs: ['coverage'] } } }, 'test'), /lanes\.unit\.specs cannot be set/);
  assert.throws(() => validate({ lanes: { e2e: { config: 'e.ts', specs: ['covered'] } } }, 'test'), /entries are "imports", "coverage", \{ "map"/);
});

test('map: a lane without prepare runs none, a passing package logs no failures, a crash message keeps the last six lines', async () => {
  const bare = validate({ lanes: { e2e: { config: 'vitest-e2e.config.ts', specs: 'coverage' } } }, 'test').lanes[1]!;
  const { base, logs } = input({ lane: bare });
  await mapCommand(base);
  assert.deepEqual(logs, ['e2e services/api: running the whole suite', 'e2e services/web: running the whole suite']);
  const long = Array.from({ length: 9 }, (_, i) => `line ${i + 1}`).join('\n');
  const crashed = input({ lane: bare, executed: { 'services/api': {} }, results: { 'services/api': { passed: 0, output: `${long}\n` } } });
  assert.deepEqual((await mapCommand(crashed.base)).failed, [{ name: 'services/api', dir: 'services/api', why: 'line 4\nline 5\nline 6\nline 7\nline 8\nline 9' }]);
});

test('map: specs that ran no function of any source make no map', async () => {
  const empty = input({ executed: { 'services/api': { [`${repo}/services/api/test/a.e2e.ts`]: [] }, 'services/web': { [`${repo}/services/web/test/a.e2e.ts`]: ['/elsewhere/x.ts'] } } });
  await assert.rejects(mapCommand(empty.base), (e: unknown) => e instanceof MapFailedError && /ran 2 spec\(s\) but none ran a function of a source file/.test(e.message));
  assert.deepEqual(empty.written, []);
});

test('laneFinder: "coverage" reads the lane\'s map through the store, and needs one', () => {
  const maps = { read: () => undefined, write: () => '' };
  const both = laneFinder(lane, config, undefined, 'org/app', maps);
  assert.ok(both instanceof FirstSpecFinder);
  const only = laneFinder({ ...lane, specs: ['coverage'] }, config, undefined, 'org/app', maps);
  assert.ok(only instanceof CoverageSpecFinder);
  assert.deepEqual(only.warnings?.(), [], 'nothing said before the map is needed');
  assert.throws(() => laneFinder(lane, config, undefined, 'org/app'), /lane e2e lists coverage, which needs a map store and the repository key/);
  assert.throws(() => laneFinder(lane, config, undefined, undefined, maps), /needs a map store and the repository key/);
});

test('map: a spec that ran no source keeps an empty list when others ran some', async () => {
  const mixed = input({ executed: { 'services/api': { [`${repo}/services/api/test/a.e2e.ts`]: [`${repo}/services/api/src/a.ts`] }, 'services/web': { [`${repo}/services/web/test/config.e2e.ts`]: ['/elsewhere/x.ts'] } } });
  const { map } = await mapCommand(mixed.base);
  assert.deepEqual(map.specs, { 'services/api/test/a.e2e.ts': ['services/api/src/a.ts'], 'services/web/test/config.e2e.ts': [] });
});

test('planMap: the lane, the repository key every run uses, and a work folder outside the repo; refuses what no run would read', () => {
  const now = new Date('2026-11-25T10:00:00.000Z');
  const o = { repoRoot: repo, remote: 'app' as string | undefined, config, laneName: 'e2e', out: undefined as string | undefined, home: '/home/.weakspot', now };
  assert.deepEqual(planMap(o), { lane, repoKey: 'app', workDir: '/home/.weakspot/runs/app/map-e2e-2026-11-25T10-00-00-000Z' });
  assert.equal(planMap({ ...o, remote: undefined }).repoKey, path.basename(repo), 'no origin: the folder name, as runs use');
  assert.equal(planMap({ ...o, out: '/tmp/m' }).workDir, '/tmp/m');
  assert.throws(() => planMap({ ...o, out: path.join(repo, 'm') }), (e: unknown) => e instanceof UsageError && /is inside the repo/.test(e.message));
  assert.throws(() => planMap({ ...o, laneName: 'e3' }), /map: unknown lane e3; configured: unit, e2e/);
  assert.throws(() => planMap({ ...o, laneName: 'unit' }), /map: the unit lane does not list "coverage" in its specs/);
  const noCoverage = validate({ lanes: { e2e: { config: 'vitest-e2e.config.ts', specs: 'imports' } } }, 'test');
  assert.throws(() => planMap({ ...o, config: noCoverage }), /the e2e lane does not list "coverage"/);
});

test('map: every prepare runs before the first suite, so a failing one stops the map before any suite runs', async () => {
  mkdirSync(path.join(repo, 'services/web/broken'), { recursive: true });
  const failing = validate({ lanes: { e2e: { config: 'vitest-e2e.config.ts', specs: 'coverage', prepare: 'test ! -d broken' } } }, 'test').lanes[1]!;
  const { base, calls, logs } = input({ lane: failing });
  await assert.rejects(mapCommand(base), (e: unknown) => e instanceof Error && e.name === 'PrepareError' && exitCodeFor(e) === 3);
  assert.deepEqual(calls, [], 'no suite ran');
  assert.deepEqual(logs, ['e2e services/api: prepare: test ! -d broken', 'e2e services/web: prepare: test ! -d broken']);
  const passing = input();
  await mapCommand(passing.base);
  assert.deepEqual(passing.logs.slice(0, 3).map((l) => l.split(': ')[1]), ['prepare', 'prepare', 'running the whole suite'], 'both prepares come first');
});
