import assert from 'node:assert/strict';
import { test } from 'vitest';
import { checkUsage, laneSelectionOf, scopeOf, withFlags, type Flags } from '../src/cli/flags.ts';
import { validate } from '../src/cli/config.ts';

const config = validate({ timeoutMs: 1000, concurrency: 4, lanes: { e2e: { config: 'vitest-e2e.config.ts', specs: 'imports', timeoutMs: 9000, concurrency: 2 } } }, 'cfg');

test('checkUsage refuses unknown commands and flags that do not fit the command', () => {
  assert.throws(() => checkUsage('mutate', [], {}), /unknown command mutate/);
  assert.throws(() => checkUsage('files', [], {}), /files: give at least one path/);
  assert.throws(() => checkUsage('diff', ['a.ts'], {}), /diff takes no paths/);
  assert.throws(() => checkUsage('diff', [], { staged: true, committed: true }), /--staged and --committed exclude each other/);
  for (const flag of [{ base: 'main' }, { staged: true }, { committed: true }] as Flags[]) {
    assert.throws(() => checkUsage('files', ['a.ts'], flag), /--base, --staged and --committed apply to diff only/);
  }
  assert.doesNotThrow(() => checkUsage('files', ['a.ts'], {}));
  assert.doesNotThrow(() => checkUsage('diff', [], { staged: true, base: 'main' }));
});

test('withFlags: a limit flag overrides the top level and every lane; without it each lane keeps its own', () => {
  const kept = withFlags(config, {});
  assert.deepEqual(kept.lanes.map((l) => [l.name, l.timeoutMs, l.concurrency]), [['unit', 1000, 4], ['e2e', 9000, 2]]);
  const flagged = withFlags(config, { 'timeout-ms': '500', concurrency: '3', depth: '2', exclude: 'A,,B' });
  assert.equal(flagged.timeoutMs, 500);
  assert.equal(flagged.concurrency, 3);
  assert.equal(flagged.specDepth, 2);
  assert.deepEqual(flagged.excludedMutations, ['A', 'B']);
  assert.deepEqual(flagged.lanes.map((l) => [l.name, l.timeoutMs, l.concurrency]), [['unit', 500, 3], ['e2e', 500, 3]]);
  assert.throws(() => withFlags(config, { depth: '3' }), /--depth must be 1 or 2/);
  assert.throws(() => withFlags(config, { concurrency: '0' }), /--concurrency must be a positive integer/);
});

test('laneSelectionOf: --specs needs the unit lane in a --lanes list; unknown lanes are a usage error', () => {
  assert.equal(laneSelectionOf({}, config), 'fallback');
  assert.equal(laneSelectionOf({ lanes: 'all', specs: ['x.test.ts'] }, config), 'all');
  assert.deepEqual(laneSelectionOf({ lanes: 'unit,e2e', specs: ['x.test.ts'] }, config), ['unit', 'e2e']);
  assert.throws(() => laneSelectionOf({ lanes: 'e2e', specs: ['x.test.ts'] }, config), /--specs names specs for the unit lane/);
  assert.throws(() => laneSelectionOf({ lanes: 'nope' }, config), (err: unknown) => err instanceof Error && err.name === 'UsageError' && /unknown lane nope/.test(err.message));
});

test('scopeOf: committed wins over staged, working by default', () => {
  assert.equal(scopeOf({}), 'working');
  assert.equal(scopeOf({ staged: true }), 'staged');
  assert.equal(scopeOf({ committed: true }), 'committed');
});
