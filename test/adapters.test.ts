import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dryRunFailures, mutatePatterns } from '../src/adapters/stryker/stryker-engine.ts';
import { shimSource } from '../src/adapters/vitest/vitest-runner.ts';
import { validate } from '../src/cli/config.ts';

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
  assert.match(src, /const \{ dir, root: _testRoot, projects, workspace, alias: testAlias, \.\.\.test \}/);
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
  const ok = validate({ timeoutMs: 500, vitest: { pool: 'forks' } }, 'cfg');
  assert.equal(ok.timeoutMs, 500);
  assert.deepEqual(ok.vitest, { pool: 'forks' });
});
