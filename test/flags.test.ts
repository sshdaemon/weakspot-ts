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
    assert.throws(() => checkUsage('files', ['a.ts'], flag), /--base, --staged, --committed and --changes apply to diff only/);
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
  assert.equal(withFlags(config, { escalate: 'survivors' }).escalate, 'survivors');
  assert.equal(withFlags(config, {}).escalate, 'untested');
  assert.equal(withFlags({ ...config, escalate: 'noCoverage' }, {}).escalate, 'noCoverage', 'without the flag the config value stands');
  assert.throws(() => withFlags(config, { escalate: 'x' }), /--escalate must be one of/);
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

test('accept: one valid id, a reason unless revoking, and no run flags', () => {
  const id = 'src/a.ts#EqualityOperator#0123456789ab';
  assert.doesNotThrow(() => checkUsage('accept', [id], { reason: 'equivalent' }));
  assert.doesNotThrow(() => checkUsage('accept', ['src/a.ts#untested'], { revoke: true, repo: '.' }));
  assert.throws(() => checkUsage('accept', [], { reason: 'x' }), /give exactly one id/);
  assert.throws(() => checkUsage('accept', ['src/a.ts'], { reason: 'x' }), /is not a survivor id/);
  assert.throws(() => checkUsage('accept', [id], {}), /--reason is required/);
  assert.throws(() => checkUsage('accept', [id], { reason: '  ' }), /--reason is required/);
  assert.throws(() => checkUsage('accept', [id], { revoke: true, reason: 'x' }), /--revoke takes no --reason/);
  assert.throws(() => checkUsage('accept', [id], { reason: 'x', base: 'main' }), /--base do not apply/);
  assert.throws(() => checkUsage('diff', [], { reason: 'x' }), /--reason and --revoke apply to accept only/);
});

test('--escalate other than untested is refused with --lanes', () => {
  assert.throws(() => checkUsage('diff', [], { lanes: 'all', escalate: 'noCoverage' }), /--escalate retries survivors in the next lane/);
  assert.doesNotThrow(() => checkUsage('diff', [], { lanes: 'all', escalate: 'untested' }));
  assert.doesNotThrow(() => checkUsage('diff', [], { escalate: 'survivors' }));
  assert.doesNotThrow(() => checkUsage('diff', [], { lanes: 'all' }));
});

test('--changes: diff only, and not with the flags that pick the lines from git', () => {
  assert.doesNotThrow(() => checkUsage('diff', [], { changes: 'c.json' }));
  assert.throws(() => checkUsage('files', ['a.ts'], { changes: 'c.json' }), /apply to diff only/);
  for (const flag of [{ base: 'main' }, { staged: true }, { committed: true }] as Flags[]) {
    assert.throws(() => checkUsage('diff', [], { changes: 'c.json', ...flag }), /--changes names the base and lines itself/);
  }
});

test('propose: a diff without paths, named files with them; engine flags and run flags do not apply', () => {
  assert.doesNotThrow(() => checkUsage('propose', [], { base: 'main' }));
  assert.doesNotThrow(() => checkUsage('propose', [], { changes: 'c.json', lanes: 'all' }));
  assert.doesNotThrow(() => checkUsage('propose', ['a.ts:3-9'], { specs: ['a.test.ts'] }));
  assert.throws(() => checkUsage('propose', ['a.ts'], { base: 'main' }), /apply to diff only, not to named files/);
  assert.throws(() => checkUsage('propose', [], { escalate: 'survivors', 'timeout-ms': '9' }), /propose runs no tests: --escalate, --timeout-ms do not apply/);
  assert.doesNotThrow(() => checkUsage('diff', [], { escalate: 'survivors', 'timeout-ms': '9', concurrency: '2', exclude: 'X' }), 'the engine flags still apply to diff');
  assert.throws(() => checkUsage('propose', [], { mutants: 'm.json' }), /--mutants and --placeholders apply to run only/);
  assert.throws(() => checkUsage('diff', [], { placeholders: 'p.json' }), /apply to run only/);
});

test('run: --mutants required, no paths, and only the flags it reads', () => {
  assert.doesNotThrow(() => checkUsage('run', [], { mutants: 'm.json', placeholders: 'p.json', out: 'o', repo: '.', quiet: true, 'timeout-ms': '9', concurrency: '2' }));
  assert.throws(() => checkUsage('run', [], {}), /run: --mutants <file> is required/);
  assert.throws(() => checkUsage('run', ['a.ts'], { mutants: 'm.json' }), /run takes no paths/);
  assert.throws(() => checkUsage('run', [], { mutants: 'm.json', base: 'main', lanes: 'all' }), /run: --base, --lanes do not apply/);
});

test('pr: one number or URL, or --clean alone; the lines come from the pull request', () => {
  assert.doesNotThrow(() => checkUsage('pr', ['12'], { keep: true, escalate: 'survivors', specs: ['a.test.ts'] }));
  assert.doesNotThrow(() => checkUsage('pr', ['https://github.com/org/app/pull/12'], {}));
  assert.doesNotThrow(() => checkUsage('pr', [], { clean: true, repo: '.', quiet: true }));
  assert.throws(() => checkUsage('pr', [], {}), /pr: give one pull request number or URL/);
  assert.throws(() => checkUsage('pr', ['1', '2'], {}), /give one pull request/);
  assert.throws(() => checkUsage('pr', ['feature'], {}), /pr: feature is not a pull request number or URL/);
  for (const bad of ['12abc', 'x12', 'https://github.com/org/app/issues/12']) assert.throws(() => checkUsage('pr', [bad], {}), /is not a pull request number or URL/, bad);
  assert.doesNotThrow(() => checkUsage('pr', ['https://github.com/org/app/pull/12/files'], {}), 'a URL from the Files tab');
  assert.throws(() => checkUsage('pr', ['12'], { base: 'main', changes: 'c.json' }), /pr: the pull request names its base and lines; --base, --changes do not apply/);
  assert.throws(() => checkUsage('pr', ['12'], { clean: true }), /pr --clean takes no pull request/);
  assert.throws(() => checkUsage('pr', [], { clean: true, keep: true }), /pr --clean takes no pull request and no other flags/);
  assert.throws(() => checkUsage('diff', [], { keep: true }), /--keep and --clean apply to pr only/);
  assert.throws(() => checkUsage('files', ['a.ts'], { clean: true }), /apply to pr only/);
});
