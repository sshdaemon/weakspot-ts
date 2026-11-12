import assert from 'node:assert/strict';
import { test } from 'vitest';
import { dryRunFailures, mutatePatterns } from '../src/adapters/stryker/stryker-engine.ts';
import { VitestRunner, envSource, shimSource } from '../src/adapters/vitest/vitest-runner.ts';
import { validate } from '../src/cli/config.ts';
import { workerOffsets } from '../src/cli/pipeline.ts';

const planWith = (concurrency: number) => ({ lane: { name: 'l', timeoutMs: 1, concurrency, env: {} }, pkg: { dir: '/p', name: 'p', testConfig: '/p/v.ts' }, targets: [], specs: [] });
const appWithConfig = (testConfig: string) => ({ dir: '/repo/app', name: 'app', testConfig });
const laneWithSpecs = (specs: unknown) => ({ lanes: { e2e: { config: 'x.config.ts', specs } } });

test('mutatePatterns escapes glob characters with bracket classes and appends ranges', () => {
  assert.deepEqual(mutatePatterns('src/pages/[id]/price.ts', 'whole'), ['src/pages/[[]id[]]/price.ts']);
  assert.deepEqual(mutatePatterns('src/a.ts', [{ start: 3, end: 9 }, { start: 20, end: 20 }]), ['src/a.ts:3-9', 'src/a.ts:20-20']);
});

test('dryRunFailures returns the test names after the failure line, none when the dry run passed', () => {
  const log = [
    '10:00:00 (1) INFO DryRunExecutor Starting initial test run',
    '10:00:01 (1) ERROR DryRunExecutor One or more tests failed in the initial test run:',
    '\tdiscounted > rounds to the nearest penny',
    '\t\texpected 669 to be 670 // Object.is equality',
    '10:00:01 (1) ERROR Stryker There were failed tests in the initial test run.',
  ].join('\n');
  assert.equal(dryRunFailures(log), 'discounted > rounds to the nearest penny\nexpected 669 to be 670 // Object.is equality');
  assert.equal(dryRunFailures('10:00:01 (1) INFO DryRunExecutor Initial test run succeeded.'), undefined);
});

test('shim source rebases aliases, strips dir/root/projects and disables the cache', () => {
  const src = shimSource({ dir: '/repo/app', name: 'app', testConfig: '/repo/app/vitest.config.ts' }, { root: 'cwd', include: ['src/a.test.ts'] });
  assert.match(src, /const PKG = "\/repo\/app"/);
  assert.match(src, /const root = process\.cwd\(\)/);
  assert.match(src, /const \{ dir, root: _testRoot, projects, workspace, alias: testAlias, globalSetup, \.\.\.test \}/);
  assert.ok(src.indexOf("import './weakspot-env.mjs'") < src.indexOf('import raw from'), 'the env module loads before the package config');
  assert.match(src, /globalSetup\.map\(inPackage\)/, 'globalSetup stays in the real package');
  assert.match(src, /isModule\(p\)\) \? p : path\.resolve\(PKG, p\)/, 'a bare specifier the package resolves is a module and stays');
  assert.match(src, /cache: false, fsModuleCache: false/);
  assert.match(src, /include: \["src\/a\.test\.ts"\]/);
  const fixed = shimSource({ dir: '/repo/app', name: 'app', testConfig: '/repo/app/vitest.config.ts' }, { root: '/sandbox', include: [] });
  assert.match(fixed, /const root = "\/sandbox"/);
});

test('config validation names the bad field', () => {
  assert.throws(() => validate({ skip: 'nope' }, 'cfg'), /skip must be an array of strings/);
  assert.throws(() => validate({ skip: ['('] }, 'cfg'), /not a valid regex/);
  assert.throws(() => validate({ concurrency: 0 }, 'cfg'), /concurrency must be a positive integer/);
  assert.throws(() => validate({ vitest: [] }, 'cfg'), /vitest must be an object/);
  assert.throws(() => validate({ specPattern: '[' }, 'cfg'), /specPattern .* not a valid regex/);
  assert.throws(() => validate({ e2ePattern: '' }, 'cfg'), /e2ePattern must be a non-empty string/);
  const ok = validate({ timeoutMs: 500, vitest: { pool: 'forks' } }, 'cfg');
  assert.equal(ok.timeoutMs, 500);
  assert.deepEqual(ok.vitest, { pool: 'forks' });
});

test('env module fills {worker} from the engine variable plus the run offset, and falls back to the offset alone', () => {
  const src = envSource({ DB_PREFIX: 'ws_{worker}', FLAG: '1' }, 'STRYKER_MUTATOR_WORKER', 200);
  assert.match(src, /const worker = String\(200 \+ Number\(process\.env\["STRYKER_MUTATOR_WORKER"\] \?\? '0'\)\);/);
  assert.match(src, /process\.env\["DB_PREFIX"\] = "ws_\{worker\}"\.split\('\{worker\}'\)\.join\(worker\);/);
  assert.match(src, /process\.env\["FLAG"\] = "1"/);
  assert.match(envSource({}, undefined), /const worker = String\(0 \+ 0\);/);
});

test('worker offsets give every plan its own stretch of ids, wider than its concurrency', () => {
  assert.deepEqual(workerOffsets([planWith(8), planWith(2), planWith(50)]), [0, 100, 200]);
  assert.deepEqual(workerOffsets([planWith(50), planWith(1)]), [0, 500]);
});

test('vitest runner detects named config variants, not other tools', () => {
  const runner = new VitestRunner();
  assert.ok(runner.detect(appWithConfig('/repo/app/vitest.config.mts')));
  assert.ok(runner.detect(appWithConfig('/repo/app/vitest-e2e.config.mts')));
  assert.ok(runner.detect(appWithConfig('/repo/app/vite.config.ts')));
  assert.ok(!runner.detect(appWithConfig('/repo/app/jest.config.ts')));
  assert.ok(!runner.detect(appWithConfig('/repo/app/vitest-e2e.setup.ts')));
});

test('lane config: unit first, config and specs required, limits default to the top level', () => {
  const cfg = validate(
    {
      timeoutMs: 500,
      lanes: {
        e2e: { config: 'vitest-e2e.config.mts', specs: { map: [['^apps/(\\w+)/src/', 'apps/$1/test/**/*.e2e-spec.ts']] }, envPerWorker: { DB: 'x_{worker}' }, concurrency: 2 },
      },
    },
    'cfg',
  );
  assert.deepEqual(cfg.lanes.map((l) => l.name), ['unit', 'e2e']);
  assert.equal(cfg.lanes[0]!.timeoutMs, 500);
  assert.deepEqual(cfg.lanes[0]!.specs, ['imports']);
  assert.equal(cfg.lanes[1]!.timeoutMs, 500, 'lane limit defaults to the top level');
  assert.equal(cfg.lanes[1]!.concurrency, 2);
  assert.deepEqual(cfg.lanes[1]!.envPerWorker, { DB: 'x_{worker}' });
  const several = validate({ lanes: { unit: { timeoutMs: 9 }, int: { config: 'vitest-int.config.ts', specs: ['imports', { command: 'bin/specs-for' }] } } }, 'cfg');
  assert.equal(several.lanes[0]!.timeoutMs, 9);
  assert.deepEqual(several.lanes[1]!.specs, ['imports', { command: 'bin/specs-for' }]);
  assert.throws(() => validate({ lanes: { e2e: { specs: 'imports' } } }, 'cfg'), /lanes\.e2e\.config is required/);
  assert.throws(() => validate({ lanes: { e2e: { config: 'x.config.ts' } } }, 'cfg'), /lanes\.e2e\.specs is required/);
  assert.throws(() => validate({ lanes: { e2e: { config: 'a/x.config.ts', specs: 'imports' } } }, 'cfg'), /must be a file name/);
  assert.throws(() => validate({ lanes: { e2e: { config: 'x.config.ts', specs: { map: [['(', 'g']] } } } }, 'cfg'), /not a valid regex/);
  assert.throws(() => validate({ lanes: { e2e: { config: 'x.config.ts', specs: 'imports' }, unit: {} } }, 'cfg'), /unit lane must be listed first/);
  assert.throws(() => validate({ lanes: { unit: { specs: 'imports' } } }, 'cfg'), /lanes\.unit\.specs cannot be set/);
  assert.throws(() => validate({ lanes: { E2E: { config: 'x.config.ts', specs: 'imports' } } }, 'cfg'), /lane name "E2E"/);
  assert.throws(() => validate({ lanes: { e2e: { config: 'x.config.ts', specs: 'imports', envPerWorker: { A: 1 } } } }, 'cfg'), /envPerWorker must be an object of string values/);
  assert.throws(() => validate({ lanes: { e2e: { config: 'vitest.config.ts', specs: 'imports' } } }, 'cfg'), /is the unit lane's config/);
  assert.deepEqual(validate({}, 'cfg').lanes.map((l) => l.name), ['unit'], 'no lanes key still gives the unit lane');
  for (const bad of [{ map: [['^a', 1]] }, { map: [['^a']] }, { map: ['^a'] }, { map: [['^a', 'g', 'h']] }]) {
    assert.throws(() => validate(laneWithSpecs(bad), 'cfg'), /lanes\.e2e\.specs\.map entries are \[regex, glob\] pairs/);
  }
  for (const bad of [{ command: '  ' }, { command: 5 }, { map: 'x' }, 5, null, ['imports', 'other']]) {
    assert.throws(() => validate(laneWithSpecs(bad), 'cfg'), /lanes\.e2e\.specs entries are "imports"/);
  }
  assert.deepEqual(validate(laneWithSpecs([{ map: [['^a', 'g']] }, { command: 'x' }]), 'cfg').lanes[1]!.specs, [{ map: [['^a', 'g']] }, { command: 'x' }]);
  for (const bad of [[], null, 'e2e']) assert.throws(() => validate({ lanes: bad }, 'cfg'), /lanes must be an object keyed by lane name/);
  for (const bad of [[], null]) assert.throws(() => validate({ lanes: { e2e: bad } }, 'cfg'), /lanes\.e2e must be an object/);
  for (const name of ['1e2e', 'e2e_', '-e2e']) assert.throws(() => validate({ lanes: { [name]: { config: 'x.config.ts', specs: 'imports' } } }, 'cfg'), /must be lowercase letters, digits and dashes/);
  assert.throws(() => validate({ lanes: { e2e: { config: 'x.config.ts', specs: 'imports', envPerWorker: { A: 'x', B: 1 } } } }, 'cfg'), /envPerWorker must be an object of string values/);
  assert.deepEqual(validate({ lanes: { e2e: { config: 'x.config.ts', specs: 'imports', envPerWorker: { A: 'x' } } } }, 'cfg').lanes[1]!.envPerWorker, { A: 'x' });
  assert.throws(
    () => validate({ lanes: { a: { config: 'x.config.ts', specs: 'imports' }, b: { config: 'x.config.ts', specs: 'imports' } } }, 'cfg'),
    /lanes\.b and lanes\.a share the config "x\.config\.ts"/,
  );
});
