import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import type { ChangedFile, Package, SpecSet } from '../src/change/types.ts';
import { validate } from '../src/cli/config.ts';
import { runPipeline, type PipelineInput } from '../src/cli/pipeline.ts';
import type { LaneSelection } from '../src/mutation/lanes.ts';
import type { EngineRunResult, PackagePlan } from '../src/mutation/types.ts';
import type { MutationEngine } from '../src/ports/mutation-engine.ts';
import type { PackageLocator } from '../src/ports/package-locator.ts';
import type { SpecFinder } from '../src/ports/spec-finder.ts';
import type { TestRunner } from '../src/ports/test-runner.ts';

/**
 * Two packages: `app` has a unit config and an e2e config, `lib` only a unit config. The engine
 * records the plans it gets and returns no mutants; the finders answer from tables.
 */
let repo: string;
let out: string;
let app: Package;
let lib: Package;
let e2eOnly: Package;

beforeEach(() => {
  repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'weakspot-pipeline-repo-')));
  out = mkdtempSync(path.join(os.tmpdir(), 'weakspot-pipeline-out-'));
  for (const f of ['app/vitest.config.ts', 'app/vitest-e2e.config.ts', 'lib/vitest.config.ts', 'e2eonly/vitest-e2e.config.ts']) {
    mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    writeFileSync(path.join(repo, f), '');
  }
  app = { dir: path.join(repo, 'app'), name: 'app', testConfig: path.join(repo, 'app/vitest.config.ts') };
  lib = { dir: path.join(repo, 'lib'), name: 'lib', testConfig: path.join(repo, 'lib/vitest.config.ts') };
  e2eOnly = { dir: path.join(repo, 'e2eonly'), name: 'e2eonly', testConfig: path.join(repo, 'e2eonly/vitest-e2e.config.ts') };
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

const set = (file: string, specs: string[]): SpecSet => ({ file, specs, how: specs.length ? 'imports' : 'none' });
const table = (specs: Record<string, string[]>): SpecFinder => ({ find: (_root, _pkg, file) => set(file, specs[file] ?? []) });

function run(
  changed: ChangedFile[],
  selection: LaneSelection,
  unit: Record<string, string[]>,
  e2e: Record<string, string[]>,
  specImports: Record<string, string[]> = {},
  opts: { detect?: (pkg: Package) => boolean; specs?: string[] } = {},
) {
  const plans: PackagePlan[] = [];
  const logs: string[] = [];
  const e2eExplicit: (readonly string[])[] = [];
  const e2eFinder = table(e2e);
  const engine: MutationEngine = {
    name: 'fake',
    workerIdVariable: 'W',
    run: async (plan): Promise<EngineRunResult> => {
      plans.push(plan);
      return { pkg: plan.pkg, mutants: [], testCount: 0, durationMs: 0, artifacts: {} };
    },
  };
  const runner: TestRunner = { name: 'fake', detect: opts.detect ?? (() => true), writeShim: () => '', engineConfig: () => ({}), run: async () => ({ passed: 0, failed: 0, timedOut: false, durationMs: 0, output: '' }) };
  const packages: PackageLocator = { repoRoot: () => repo, packageOf: (_root, abs) => [app, lib, e2eOnly].find((p) => abs.startsWith(p.dir + '/')) };
  const config = validate({ lanes: { e2e: { config: 'vitest-e2e.config.ts', specs: 'imports' } } }, 'test');
  const input: PipelineInput = {
    changed,
    change: { kind: 'diff', detail: 'test' },
    specs: opts.specs ?? [],
    repoRoot: repo,
    out,
    config,
    runner,
    engine,
    specFinder: table(unit),
    imports: { importsOf: (_root, _pkg, abs) => (specImports[path.relative(repo, abs)] ?? []).map((f) => path.join(repo, f)) },
    lanes: [
      {
        config: config.lanes[1]!,
        finder: {
          find: (root, pkg, f, explicit) => {
            e2eExplicit.push(explicit);
            return e2eFinder.find(root, pkg, f, explicit);
          },
        },
      },
    ],
    laneSelection: selection,
    packages,
    log: (line) => logs.push(line),
    commandLine: 'test',
    version: 'test',
  };
  return runPipeline(input).then(({ report }) => ({ report, plans, logs, e2eExplicit }));
}

const file = (p: string): ChangedFile => ({ path: p, status: 'modified', ranges: [{ start: 1, end: 2 }] });

test.each<[string, LaneSelection]>([
  ['fallback', 'fallback'],
  ['all', 'all'],
  ['unit,e2e', ['unit', 'e2e']],
])('a changed unit spec adds its sources to the unit lane only; a later lane never takes them (%s)', async (_name, selection) => {
  const { report, plans } = await run(
    [file('app/src/a.test.ts')],
    selection,
    {},
    { 'app/src/a.ts': ['app/e2e/a.e2e-spec.ts'] },
    { 'app/src/a.test.ts': ['app/src/a.ts'] },
  );
  assert.deepEqual(report.viaChangedSpec, ['app/src/a.ts']);
  assert.deepEqual(plans.map((p) => [p.lane.name, p.targets.map((t) => t.file), p.specs]), [['unit', ['app/src/a.ts'], ['app/src/a.test.ts']]]);
  assert.deepEqual(report.dropped, [{ path: 'app/src/a.test.ts', reason: 'spec file' }]);
  assert.deepEqual(report.viaFallback, []);
});

test('with a lane selection that leaves out unit, the changed-spec rule does not run', async () => {
  const { report, plans } = await run([file('app/src/a.test.ts')], ['e2e'], {}, { 'app/src/a.ts': ['app/e2e/a.e2e-spec.ts'] }, { 'app/src/a.test.ts': ['app/src/a.ts'] });
  assert.deepEqual(report.viaChangedSpec, []);
  assert.deepEqual(plans, []);
});

test('fallback, lane packages and untested evidence: each lane takes only its own config, and evidence names the lanes that looked', async () => {
  const { report, plans } = await run(
    [file('app/src/unit.ts'), file('app/src/e2e.ts'), file('app/src/none.ts'), file('lib/src/none.ts'), file('tools/x.ts')],
    'fallback',
    { 'app/src/unit.ts': ['app/src/unit.test.ts'] },
    { 'app/src/unit.ts': ['app/e2e/unit.e2e-spec.ts'], 'app/src/e2e.ts': ['app/e2e/e2e.e2e-spec.ts'], 'lib/src/none.ts': ['lib/e2e/x.e2e-spec.ts'] },
  );
  assert.deepEqual(plans.map((p) => [p.lane.name, p.pkg.testConfig, p.targets.map((t) => t.file)]), [
    ['unit', app.testConfig, ['app/src/unit.ts']],
    ['e2e', path.join(app.dir, 'vitest-e2e.config.ts'), ['app/src/e2e.ts']],
  ]);
  assert.deepEqual(report.viaFallback, [{ file: 'app/src/e2e.ts', lane: 'e2e' }]);
  assert.deepEqual(report.untested, ['app/src/none.ts', 'lib/src/none.ts'], 'lib has no e2e config, so its e2e finder answer is never asked');
  assert.deepEqual(report.noTestConfig, ['tools/x.ts']);
  assert.deepEqual(report.dropped, [], 'kept files are never listed as skipped');
  const evidence = Object.fromEntries(report.findings.filter((f) => f.kind === 'untested').map((f) => [f.where, f.evidence]));
  assert.match(evidence['app/src/none.ts']!, /^no unit spec .*; the e2e lane's spec sources name none$/);
  assert.match(evidence['lib/src/none.ts']!, /^no unit spec in the package imports the file \([^)]*\)$/, 'the e2e lane never looked at lib');
  assert.deepEqual(report.packages.map((p) => [p.lane, p.name]), [['unit', 'app'], ['e2e', 'app']]);
  assert.deepEqual(report.warnings, ['app/src/unit.ts: produced no mutants (nothing mutable in the given range, or the path did not match)', 'app/src/e2e.ts: produced no mutants (nothing mutable in the given range, or the path did not match)']);
});

test('a package whose config the runner does not know is logged and reported as having no test config, in every lane', async () => {
  const { report, plans, logs } = await run(
    [file('app/src/a.ts'), file('lib/src/b.ts')],
    'fallback',
    { 'app/src/a.ts': ['app/src/a.test.ts'], 'lib/src/b.ts': ['lib/src/b.test.ts'] },
    { 'app/src/a.ts': ['app/e2e/a.e2e-spec.ts'] },
    {},
    { detect: (pkg) => pkg.dir !== lib.dir && !pkg.testConfig.endsWith('vitest.config.ts') },
  );
  assert.deepEqual(plans.map((p) => [p.lane.name, p.targets.map((t) => t.file)]), [['e2e', ['app/src/a.ts']]], 'app falls to its e2e config; lib has no config the runner knows');
  assert.deepEqual(report.noTestConfig, ['lib/src/b.ts']);
  assert.ok(logs.includes('app/src/a.ts: app/vitest.config.ts is not a fake config'));
  assert.ok(logs.includes('lib/src/b.ts: lib/vitest.config.ts is not a fake config'));
});

test('a package found by a lane config never runs in the unit lane, even when a unit spec imports the file', async () => {
  const { plans } = await run([file('e2eonly/src/a.ts')], 'fallback', { 'e2eonly/src/a.ts': ['e2eonly/src/a.test.ts'] }, { 'e2eonly/src/a.ts': ['e2eonly/e2e/a.e2e-spec.ts'] });
  assert.deepEqual(plans.map((p) => [p.lane.name, p.pkg.testConfig, p.specs]), [['e2e', e2eOnly.testConfig, ['e2eonly/e2e/a.e2e-spec.ts']]]);
});

test('--specs stays in the unit lane: later lanes get no explicit specs, and a file that falls to them says so', async () => {
  const { plans, logs, e2eExplicit } = await run(
    [file('app/src/a.ts'), file('e2eonly/src/b.ts')],
    'fallback',
    { 'app/src/a.ts': ['app/src/a.test.ts'] },
    { 'e2eonly/src/b.ts': ['e2eonly/e2e/b.e2e-spec.ts'] },
    {},
    { specs: ['app/src/a.test.ts'] },
  );
  assert.deepEqual(plans.map((p) => [p.lane.name, p.targets.map((t) => t.file)]), [['unit', ['app/src/a.ts']], ['e2e', ['e2eonly/src/b.ts']]]);
  assert.deepEqual(e2eExplicit, [[]]);
  assert.ok(logs.includes('e2eonly/src/b.ts: no unit spec, checked by the e2e lane (--specs ignored: its package has no unit config)'));
  const without = await run([file('e2eonly/src/b.ts')], 'fallback', {}, { 'e2eonly/src/b.ts': ['e2eonly/e2e/b.e2e-spec.ts'] });
  assert.ok(without.logs.includes('e2eonly/src/b.ts: no unit spec, checked by the e2e lane'));
});

test('--out inside the repo is a usage error', async () => {
  await assert.rejects(() => runPipeline({ repoRoot: repo, out: path.join(repo, 'out') } as unknown as PipelineInput), /inside the repo/);
});
