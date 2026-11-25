import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import type { ChangedFile, Package, SpecSet } from '../src/change/types.ts';
import { validate } from '../src/cli/config.ts';
import { EngineFailedError } from '../src/adapters/stryker/stryker-engine.ts';
import { InterruptedError, runPipeline, type PipelineInput } from '../src/cli/pipeline.ts';
import type { LaneSelection } from '../src/mutation/lanes.ts';
import type { EngineRunResult, Mutant, PackagePlan } from '../src/mutation/types.ts';
import type { AcceptedEntry } from '../src/report/suppressions.ts';
import { survivorId } from '../src/report/suppressions.ts';
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

const set = (file: string, specs: string[]): SpecSet => ({ file, specs, how: specs.length > 0 ? 'imports' : 'none' });
const table = (specs: Record<string, string[]>): SpecFinder => ({ find: (_root, _pkg, file) => set(file, specs[file] ?? []) });

function run(
  changed: ChangedFile[],
  selection: LaneSelection,
  unit: Record<string, string[]>,
  e2e: Record<string, string[]>,
  specImports: Record<string, string[]> = {},
  opts: { detect?: (pkg: Package) => boolean; specs?: string[]; mutants?: (plan: PackagePlan) => Mutant[]; engineWarnings?: string[]; extra?: Partial<PipelineInput> } = {},
) {
  const plans: PackagePlan[] = [];
  const logs: string[] = [];
  const e2eExplicit: (readonly string[])[] = [];
  const e2eFinder = table(e2e);
  const engine: MutationEngine = {
    name: 'fake',
    workerIdVariable: 'W',
    run: (plan): Promise<EngineRunResult> => {
      plans.push(plan);
      return Promise.resolve({ pkg: plan.pkg, mutants: opts.mutants?.(plan) ?? [], testCount: 0, durationMs: 0, artifacts: {}, ...(opts.engineWarnings ? { warnings: opts.engineWarnings } : {}) });
    },
  };
  const runner: TestRunner = { name: 'fake', detect: opts.detect ?? (() => true), writeShim: () => '', engineConfig: () => ({}), run: () => Promise.resolve({ passed: 0, failed: 0, failedFiles: 0, timedOut: false, durationMs: 0, output: '' }) };
  const packages: PackageLocator = { repoRoot: () => repo, packageOf: (_root, abs) => [app, lib, e2eOnly].find((p) => abs.startsWith(`${p.dir}/`)) };
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
    imports: { importsOf: (_root, _pkg, abs) => (specImports[path.relative(repo, abs)] ?? []).map((f) => path.join(repo, f)), importLines: () => new Set(), onlyImports: () => true },
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
    ...opts.extra,
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

const survivor = (path_: string, line: number, over: Partial<Mutant> = {}): Mutant => ({
  id: `${path_}#${line}`,
  file: path_,
  lane: 'unit',
  mutator: 'ConditionalExpression',
  start: { line, column: 1 },
  end: { line, column: 5 },
  original: `a > ${line}`,
  replacement: 'true',
  status: 'Survived',
  statusReason: '',
  coveredBy: 1,
  isStatic: false,
  killedBy: [],
  ...over,
});

test('accepted survivors and untested files leave the findings and are listed as accepted; noise is labelled and hidden too', async () => {
  const kept = survivor('app/src/a.ts', 3);
  const acceptedOne = survivor('app/src/a.ts', 5, { status: 'NoCoverage', coveredBy: 0 });
  const noisy = survivor('app/src/a.ts', 7);
  const entries: AcceptedEntry[] = [
    { repo: 'r', id: survivorId({ ...acceptedOne, scope: 'S.run' }), reason: 'equivalent', date: '2026-11-21T00:00:00.000Z' },
    { repo: 'r', id: 'lib/src/b.ts#untested', reason: 'covered by e2e', date: '2026-11-21T00:00:00.000Z' },
  ];
  const { report } = await run([file('app/src/a.ts'), file('lib/src/b.ts')], 'fallback', { 'app/src/a.ts': ['app/src/a.test.ts'] }, {}, {}, {
    mutants: () => [kept, acceptedOne, noisy],
    extra: {
      suppressions: { repoKey: 'r', store: { list: (key) => entries.filter((e) => e.repo === key), accept: () => {}, revoke: () => false } },
      inspector: { inspect: (_abs, ms) => new Map(ms.map((m) => [m.id, m.id === noisy.id ? { noise: 'logging' as const, scope: 'S.run' } : { scope: 'S.run' }])) },
    },
  });
  assert.deepEqual(report.findings.map((f) => f.id), [survivorId({ ...kept, scope: 'S.run' })], 'ids carry the scope the inspector read');
  assert.deepEqual(report.accepted.map((a) => [a.id, a.where, a.reason]), [
    [survivorId({ ...acceptedOne, scope: 'S.run' }), 'app/src/a.ts:5:1', 'equivalent'],
    ['lib/src/b.ts#untested', 'lib/src/b.ts', 'covered by e2e'],
  ]);
  assert.deepEqual(report.survivors.map((s) => [s.mutant.start.line, s.noise, Boolean(s.accepted)]), [[3, undefined, false], [5, undefined, true], [7, 'logging', false]]);
  assert.deepEqual(report.untested, ['lib/src/b.ts'], 'still listed as untested, but not a finding');
});

test('noise classes the config does not hide are kept as findings', async () => {
  const noisy = survivor('app/src/a.ts', 7);
  const { report } = await run([file('app/src/a.ts')], 'fallback', { 'app/src/a.ts': ['app/src/a.test.ts'] }, {}, {}, {
    mutants: () => [noisy],
    extra: { config: { ...validate({ noise: ['catchOnly'] }, 'test') }, inspector: { inspect: () => new Map([[noisy.id, { noise: 'logging' as const, scope: '' }]]) } },
  });
  assert.equal(report.survivors[0]!.noise, undefined);
  assert.equal(report.findings.length, 1);
});

test('escalation: unit survivors are retried on their lines in the next lane; killed ones leave, the rest say they survived there too', async () => {
  const uncovered = survivor('app/src/a.ts', 3, { status: 'NoCoverage', coveredBy: 0 });
  const uncoveredToo = survivor('app/src/a.ts', 5, { status: 'NoCoverage', coveredBy: 0 });
  const weak = survivor('app/src/a.ts', 9);
  const byLane = (plan: PackagePlan): Mutant[] => {
    if (plan.lane.name === 'unit') return [uncovered, uncoveredToo, weak];
    return [{ ...uncovered, id: 'e1', lane: 'e2e', status: 'Killed', coveredBy: 2 }, { ...uncoveredToo, id: 'e2', lane: 'e2e', status: 'Survived', coveredBy: 2 }];
  };
  const go = (escalate: 'noCoverage' | 'untested', selection: LaneSelection = 'fallback') =>
    run([file('app/src/a.ts')], selection, { 'app/src/a.ts': ['app/src/a.test.ts'] }, { 'app/src/a.ts': ['app/e2e/a.e2e-spec.ts'] }, {}, {
      mutants: byLane,
      extra: { config: { ...validate({ escalate, lanes: { e2e: { config: 'vitest-e2e.config.ts', specs: 'imports' } } }, 'test') } },
    });
  const { report, plans } = await go('noCoverage');
  assert.deepEqual(plans.map((p) => [p.lane.name, p.targets.map((t) => [t.file, t.ranges])]), [
    ['unit', [['app/src/a.ts', [{ start: 1, end: 2 }]]]],
    ['e2e', [['app/src/a.ts', [{ start: 3, end: 3 }, { start: 5, end: 5 }]]]],
  ]);
  assert.deepEqual(report.killedLater.map((k) => [k.where, k.lane]), [['app/src/a.ts:3:1', 'e2e']]);
  assert.deepEqual(report.survivors.map((s) => [s.mutant.start.line, s.escalated?.lane]), [[5, 'e2e'], [9, undefined]], 'the weak assertion is not retried under noCoverage');
  assert.deepEqual(report.packages.map((p) => [p.lane, p.escalated]), [['unit', false], ['e2e', true]]);
  assert.equal(report.mutants.length, 5);
  assert.match(report.findings.find((f) => f.where === 'app/src/a.ts:5:1')!.evidence, /also survives in the e2e lane with 2 covering test\(s\)/);

  const off = await go('untested');
  assert.deepEqual(off.plans.map((p) => p.lane.name), ['unit']);
  assert.deepEqual(off.report.killedLater, []);
  const all = await go('noCoverage', 'all');
  assert.deepEqual(all.plans.map((p) => p.lane.name), ['unit', 'e2e'], 'with --lanes every lane already ran every file, so nothing is retried');
  assert.ok(all.plans.every((p) => p.targets[0]!.ranges.length === 1));
});

const inE2e = (covers: boolean) => [3, 5].map((l) => survivor('app/src/a.ts', l, { lane: 'e2e', coveredBy: covers ? 1 : 0 }));

test('the never-loaded guard: a file no unit test reached passes when the escalated lane covers it, and fails when no lane does', async () => {
  // What a spec that imports a file but calls none of it produces: Survived, with no covering test.
  const all = [3, 5].map((l) => survivor('app/src/a.ts', l, { coveredBy: 0 }));
  const go = (escalate: 'noCoverage' | 'untested', e2eCovers: boolean) =>
    run([file('app/src/a.ts')], 'fallback', { 'app/src/a.ts': ['app/src/a.test.ts'] }, { 'app/src/a.ts': ['app/e2e/a.e2e-spec.ts'] }, {}, {
      mutants: (plan) => (plan.lane.name === 'unit' ? all : inE2e(e2eCovers)),
      extra: { config: { ...validate({ escalate, lanes: { e2e: { config: 'vitest-e2e.config.ts', specs: 'imports' } } }, 'test') } },
    });
  const { report } = await go('noCoverage', true);
  assert.deepEqual(report.survivors.map((s) => s.escalated?.coveredBy), [1, 1]);
  await assert.rejects(() => go('noCoverage', false), /never loaded the instrumented copy of: app\/src\/a\.ts/);
  await assert.rejects(() => go('untested', true), /never loaded the instrumented copy/, 'without escalation the guard is as before');
});

test('escalation details: survivors mode skips killed and hidden mutants, retries exact spans, runs a new lane\'s prepare once, and counts a Timeout as killed', async () => {
  const killedInUnit = survivor('app/src/a.ts', 2, { status: 'Killed' });
  const weak = survivor('app/src/a.ts', 3);
  const timesOut = survivor('app/src/a.ts', 4, { coveredBy: 0 });
  const errors = survivor('app/src/a.ts', 5, { coveredBy: 0 });
  const noisy = survivor('app/src/a.ts', 6);
  const accepted = survivor('app/src/a.ts', 7);
  const prepared = path.join(out, 'prepared.txt');
  const config = validate({ escalate: 'survivors', lanes: { e2e: { config: 'vitest-e2e.config.ts', specs: 'imports', prepare: `echo x >> '${prepared}'` } } }, 'test');
  const { report, plans } = await run([file('app/src/a.ts')], 'fallback', { 'app/src/a.ts': ['app/src/a.test.ts'] }, { 'app/src/a.ts': ['app/e2e/a.e2e-spec.ts'] }, {}, {
    mutants: (plan) =>
      plan.lane.name === 'unit'
        ? [killedInUnit, weak, timesOut, errors, noisy, accepted]
        : [
            { ...weak, id: 'e3', lane: 'e2e', coveredBy: 4 },
            { ...timesOut, id: 'e4', lane: 'e2e', status: 'Timeout' },
            { ...errors, id: 'e5', lane: 'e2e', status: 'RuntimeError' },
          ],
    extra: {
      config,
      lanes: [{ config: config.lanes[1]!, finder: table({ 'app/src/a.ts': ['app/e2e/a.e2e-spec.ts'] }) }],
      inspector: { inspect: (_abs, ms) => new Map(ms.map((m) => [m.id, m.id === noisy.id ? { noise: 'logging' as const, scope: '' } : { scope: '' }])) },
      suppressions: { repoKey: 'r', store: { list: () => [{ repo: 'r', id: survivorId({ ...accepted, scope: '' }), reason: 'fine', date: 'd' }], accept: () => {}, revoke: () => false } },
    },
  });
  const retry = plans.find((p) => p.lane.name === 'e2e')!;
  assert.deepEqual(retry.targets.map((t) => t.spans!.map((sp) => sp.start.line)), [[3, 4, 5]], 'killed, noise and accepted survivors are not retried');
  assert.equal(readFileSync(prepared, 'utf8'), 'x\n', 'the e2e prepare ran once, for the retry');
  assert.deepEqual(report.killedLater.map((k) => k.where), ['app/src/a.ts:4:1']);
  assert.deepEqual(report.survivors.map((s) => [s.mutant.start.line, s.escalated?.status]), [[3, 'Survived'], [5, 'RuntimeError'], [6, undefined], [7, undefined]]);
});

test('the guard excuses only the file a later lane covered', async () => {
  const a = [3, 5].map((l) => survivor('app/src/a.ts', l, { coveredBy: 0 }));
  const b = [3, 5].map((l) => survivor('app/src/b.ts', l, { coveredBy: 0 }));
  await assert.rejects(
    () =>
      run([file('app/src/a.ts'), file('app/src/b.ts')], 'fallback', { 'app/src/a.ts': ['app/src/a.test.ts'], 'app/src/b.ts': ['app/src/b.test.ts'] }, { 'app/src/a.ts': ['app/e2e/a.e2e-spec.ts'] }, {}, {
        mutants: (plan) => (plan.lane.name === 'unit' ? [...a, ...b] : inE2e(true)),
        extra: { config: { ...validate({ escalate: 'noCoverage', lanes: { e2e: { config: 'vitest-e2e.config.ts', specs: 'imports' } } }, 'test') } },
      }),
    /never loaded the instrumented copy of: app\/src\/b\.ts\. /,
  );
});

test('a lane prepare runs once per package across the first batch and escalation, before the lane first runs', async () => {
  const prepared = path.join(out, 'prepared-once.txt');
  const config = validate({ escalate: 'noCoverage', lanes: { e2e: { config: 'vitest-e2e.config.ts', specs: 'imports', prepare: `echo x >> '${prepared}'` } } }, 'test');
  const e2eSpecs = { 'app/src/a.ts': ['app/e2e/a.e2e-spec.ts'], 'app/src/b.ts': ['app/e2e/b.e2e-spec.ts'] };
  const seen: boolean[] = [];
  const uncovered = survivor('app/src/b.ts', 3, { status: 'NoCoverage', coveredBy: 0 });
  const { plans } = await run([file('app/src/a.ts'), file('app/src/b.ts')], 'fallback', { 'app/src/b.ts': ['app/src/b.test.ts'] }, e2eSpecs, {}, {
    mutants: (plan) => {
      if (plan.lane.name === 'unit') return [uncovered];
      seen.push(existsSync(prepared));
      return plan.targets[0]!.spans ? [{ ...uncovered, id: 'e', lane: 'e2e', status: 'Killed', coveredBy: 1 }] : [];
    },
    extra: { config, lanes: [{ config: config.lanes[1]!, finder: table(e2eSpecs) }] },
  });
  assert.deepEqual(plans.map((p) => [p.lane.name, p.targets.map((t) => t.file), Boolean(p.targets[0]!.spans)]), [
    ['unit', ['app/src/b.ts'], false],
    ['e2e', ['app/src/a.ts'], false],
    ['e2e', ['app/src/b.ts'], true],
  ]);
  assert.deepEqual(seen, [true, true], 'the prepare ran before the first e2e run');
  assert.equal(readFileSync(prepared, 'utf8'), 'x\n', 'and only once, though escalation ran the e2e lane again');
});

test('progress: report.md is rewritten as runs finish, then replaced by the final report, and packages keep plan order', async () => {
  const snapshots: string[] = [];
  const { report } = await run([file('app/src/a.ts'), file('app/src/b.ts')], 'fallback', { 'app/src/a.ts': ['app/src/a.test.ts'] }, { 'app/src/b.ts': ['app/e2e/b.e2e-spec.ts'] }, {}, {
    extra: {
      engine: {
        name: 'slow-unit',
        workerIdVariable: 'W',
        run: async (plan) => {
          // The unit run finishes after the e2e one, so it can read the snapshot the e2e run left.
          if (plan.lane.name === 'unit') {
            await new Promise((r) => setTimeout(r, 30));
            snapshots.push(readFileSync(path.join(out, 'report.md'), 'utf8'));
          }
          return { pkg: plan.pkg, mutants: [], testCount: 0, durationMs: 0, artifacts: {} };
        },
      },
    },
  });
  assert.match(snapshots[0]!, /\*\*In progress:\*\* 1 of 2 package run\(s\) done\./);
  assert.match(snapshots[0]!, /\| e2e \| app \|/);
  assert.deepEqual(report.packages.map((p) => p.lane), ['unit', 'e2e'], 'plan order, though e2e finished first');
  const final = readFileSync(path.join(out, 'report.md'), 'utf8');
  assert.doesNotMatch(final, /In progress/);
  assert.match(final, /\| unit \| app \|[\s\S]*\| e2e \| app \|/);
});

test('a run that fails after a snapshot leaves report.md marked as stopped, with no report.json', async () => {
  const failing: MutationEngine = {
    name: 'fails-second',
    workerIdVariable: 'W',
    run: async (plan) => {
      if (plan.lane.name === 'unit') {
        await new Promise((r) => setTimeout(r, 20));
        throw new EngineFailedError('stryker exited with 1 for app and wrote no report');
      }
      return { pkg: plan.pkg, mutants: [], testCount: 0, durationMs: 0, artifacts: {} };
    },
  };
  await assert.rejects(
    () => run([file('app/src/a.ts'), file('app/src/b.ts')], 'fallback', { 'app/src/a.ts': ['app/src/a.test.ts'] }, { 'app/src/b.ts': ['app/e2e/b.e2e-spec.ts'] }, {}, { extra: { engine: failing } }),
    EngineFailedError,
  );
  const md = readFileSync(path.join(out, 'report.md'), 'utf8');
  assert.match(md, /\*\*Stopped:\*\* stryker exited with 1 for app and wrote no report The run did not finish/);
  assert.doesNotMatch(md, /In progress/);
  assert.ok(!existsSync(path.join(out, 'report.json')));
});

test('an abort during a run ends as interrupted, not as the engine\'s own cancellation', async () => {
  const controller = new AbortController();
  const aborting: MutationEngine = {
    name: 'aborts',
    workerIdVariable: 'W',
    run: async (_plan, _runner, opts) => {
      controller.abort();
      await new Promise((r) => setTimeout(r, 5));
      if (opts.signal.aborted) throw new Error('cancelled by the engine');
      return { pkg: app, mutants: [], testCount: 0, durationMs: 0, artifacts: {} };
    },
  };
  await assert.rejects(
    () => run([file('app/src/a.ts')], 'fallback', { 'app/src/a.ts': ['app/src/a.test.ts'] }, {}, {}, { extra: { engine: aborting, signal: controller.signal } }),
    InterruptedError,
  );
});

test('import-only follows what each file says about its removals: known none skips, unknown widens', async () => {
  const spec = 'app/src/a.test.ts';
  const go = (changed: ChangedFile) =>
    run([changed], 'fallback', {}, {}, { [spec]: ['app/src/a.ts'] }, {
      extra: {
        imports: { importsOf: () => [path.join(repo, 'app/src/a.ts')], importLines: () => new Set([1]), onlyImports: () => true },
      },
    });
  const knownNone = await go({ path: spec, status: 'modified', ranges: [{ start: 1, end: 1 }], removed: [] });
  assert.deepEqual([knownNone.report.importOnlySpecs, knownNone.report.viaChangedSpec], [[spec], []]);
  const unknown = await go({ path: spec, status: 'modified', ranges: [{ start: 1, end: 1 }] });
  assert.deepEqual([unknown.report.importOnlySpecs, unknown.report.viaChangedSpec], [[], ['app/src/a.ts']]);
  const unquoted = await go({ path: spec, status: 'modified', ranges: [], removedUnquoted: true });
  assert.deepEqual(unquoted.report.viaChangedSpec, ['app/src/a.ts'], 'a spec that only lost lines in a change list counts');
});

test('progress during escalation: a snapshot counts retries against the number planned', async () => {
  for (const f of ['svc/vitest.config.ts', 'svc/vitest-e2e.config.ts']) {
    mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    writeFileSync(path.join(repo, f), '');
  }
  const svc: Package = { dir: path.join(repo, 'svc'), name: 'svc', testConfig: path.join(repo, 'svc/vitest.config.ts') };
  const uncovered = [survivor('app/src/b.ts', 3, { status: 'NoCoverage', coveredBy: 0 }), survivor('svc/src/c.ts', 3, { status: 'NoCoverage', coveredBy: 0 })];
  const seen: string[] = [];
  const config = validate({ escalate: 'noCoverage', lanes: { e2e: { config: 'vitest-e2e.config.ts', specs: 'imports' } } }, 'test');
  const e2eSpecs = { 'app/src/b.ts': ['app/e2e/b.e2e-spec.ts'], 'svc/src/c.ts': ['svc/e2e/c.e2e-spec.ts'] };
  await run([file('app/src/b.ts'), file('svc/src/c.ts')], 'fallback', { 'app/src/b.ts': ['app/src/b.test.ts'], 'svc/src/c.ts': ['svc/src/c.test.ts'] }, e2eSpecs, {}, {
    extra: {
      config,
      lanes: [{ config: config.lanes[1]!, finder: table(e2eSpecs) }],
      packages: { repoRoot: () => repo, packageOf: (_root, abs) => [app, svc].find((p) => abs.startsWith(`${p.dir}/`)) },
      engine: {
        name: 'staggered',
        workerIdVariable: 'W',
        run: async (plan) => {
          const mine = uncovered.filter((m) => m.file.startsWith(`${plan.pkg.name}/`));
          if (plan.lane.name === 'unit') return { pkg: plan.pkg, mutants: mine, testCount: 0, durationMs: 0, artifacts: {} };
          // svc's retry finishes second and reads the snapshot app's retry left.
          if (plan.pkg.name === 'svc') {
            await new Promise((r) => setTimeout(r, 30));
            seen.push(readFileSync(path.join(out, 'report.md'), 'utf8'));
          }
          const killed: Mutant[] = [];
          for (const m of mine) killed.push({ ...m, id: `e-${m.id}`, lane: 'e2e', status: 'Killed', coveredBy: 1 });
          return { pkg: plan.pkg, mutants: killed, testCount: 0, durationMs: 0, artifacts: {} };
        },
      },
    },
  });
  assert.match(seen[0]!, /\*\*In progress:\*\* first pass done; 1 of 2 retry run\(s\) in a later lane done\./);
  assert.doesNotMatch(readFileSync(path.join(out, 'report.md'), 'utf8'), /In progress|Stopped/, 'the final page has no banner');
});

test('the report contract: top-level keys of report.json and schemaVersion', async () => {
  const { report } = await run([file('app/src/a.ts')], 'fallback', { 'app/src/a.ts': ['app/src/a.test.ts'] }, {});
  assert.equal(report.schemaVersion, 1);
  assert.deepEqual(Object.keys(report).toSorted(), [
    'accepted', 'change', 'command', 'createdAt', 'dropped', 'findings', 'importOnlySpecs', 'killedLater', 'mutants', 'noTestConfig', 'packages', 'repo', 'schemaVersion', 'survivors', 'tool', 'untested', 'version', 'viaChangedSpec', 'viaFallback', 'warnings',
  ]);
  assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8')).schemaVersion, 1);
});

test('a reused --out loses both old reports, whether the run fails in its only engine run or in a prepare step', async () => {
  const seed = () => {
    writeFileSync(path.join(out, 'report.json'), '{"old": true}');
    writeFileSync(path.join(out, 'report.md'), '# weakspot report\n\nold');
  };
  seed();
  const config = validate({ lanes: { e2e: { config: 'vitest-e2e.config.ts', specs: 'imports', prepare: 'exit 1' } } }, 'test');
  await assert.rejects(
    () => run([file('app/src/b.ts')], 'fallback', {}, { 'app/src/b.ts': ['app/e2e/b.e2e-spec.ts'] }, {}, { extra: { config, lanes: [{ config: config.lanes[1]!, finder: table({ 'app/src/b.ts': ['app/e2e/b.e2e-spec.ts'] }) }] } }),
    /prepare command exited with 1/,
  );
  assert.ok(!existsSync(path.join(out, 'report.json')) && !existsSync(path.join(out, 'report.md')), 'a failed prepare leaves no old report');
  seed();
  const failing: MutationEngine = {
    name: 'fails',
    workerIdVariable: 'W',
    run: () => Promise.reject(new EngineFailedError('stryker exited with 1')),
  };
  await assert.rejects(() => run([file('app/src/a.ts')], 'fallback', { 'app/src/a.ts': ['app/src/a.test.ts'] }, {}, {}, { extra: { engine: failing } }), EngineFailedError);
  assert.ok(!existsSync(path.join(out, 'report.json')) && !existsSync(path.join(out, 'report.md')), 'a failed only engine run leaves no old report');
});

test('engine warnings reach the report once, after the per-file ones', async () => {
  const { report } = await run(
    [file('app/src/unit.ts'), file('app/src/e2e.ts')],
    'fallback',
    { 'app/src/unit.ts': ['app/src/unit.test.ts'] },
    { 'app/src/e2e.ts': ['app/e2e/e2e.e2e-spec.ts'] },
    {},
    { engineWarnings: ['app/.tools/x: link to a directory, left out of the mutation sandbox'] },
  );
  assert.equal(report.packages.length, 2);
  assert.deepEqual(report.warnings.slice(-1), ['app/.tools/x: link to a directory, left out of the mutation sandbox']);
  assert.equal(report.warnings.filter((w) => w.includes('link to a directory')).length, 1);
});

function neverLoaded(plan: PackagePlan): Mutant[] {
  return plan.targets.map((t) => ({
    id: `${t.file}#1`,
    file: t.file,
    lane: plan.lane.name,
    mutator: 'BooleanLiteral',
    start: { line: 1, column: 1 },
    end: { line: 1, column: 2 },
    original: 'true',
    replacement: 'false',
    status: 'Survived',
    statusReason: '',
    coveredBy: 0,
    isStatic: false,
    killedBy: [],
  }));
}

test('when the specs never loaded the instrumented copy, the error also names the engine warnings', async () => {
  await assert.rejects(
    run([file('app/src/unit.ts')], 'fallback', { 'app/src/unit.ts': ['app/src/unit.test.ts'] }, {}, {}, { mutants: neverLoaded }),
    /resolves outside the sandbox\.$/,
  );
  await assert.rejects(
    run([file('app/src/unit.ts')], 'fallback', { 'app/src/unit.ts': ['app/src/unit.test.ts'] }, {}, {}, {
      engineWarnings: ['app/src-link: link to a directory, left out of the mutation sandbox'],
      mutants: neverLoaded,
    }),
    /never loaded the instrumented copy of: app\/src\/unit\.ts\..* Also: app\/src-link: link to a directory, left out of the mutation sandbox\.$/,
  );
});

