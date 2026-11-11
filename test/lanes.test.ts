import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Package, SpecSet, TriageDecision } from '../src/change/types.ts';
import { assignLanes, parseLaneSelection, type LaneLookup } from '../src/mutation/lanes.ts';
import type { Lane } from '../src/mutation/types.ts';

const kept = (path: string): TriageDecision => ({ file: { path, status: 'modified', ranges: 'whole' }, kept: true, fileClass: 'logic', reason: '' });
const lane = (name: string): Lane => ({ name, timeoutMs: 1000, concurrency: 1, env: {} });
const api: Package = { dir: '/repo/apps/api', name: 'api', testConfig: '/repo/apps/api/vitest.config.mts' };
const apiE2e: Package = { ...api, testConfig: '/repo/apps/api/vitest-e2e.config.mts' };
const set = (file: string, specs: string[], how: SpecSet['how'] = 'imports'): SpecSet => ({ file, specs, how: specs.length ? how : 'none' });

/** unit covers a; e2e covers b and a; c has a package but no specs anywhere; d has no package at all; e has only an e2e package. */
function lookups(calls: string[]): LaneLookup[] {
  const unitSpecs: Record<string, string[]> = { 'apps/api/src/a.ts': ['apps/api/src/a.spec.ts'] };
  const e2eSpecs: Record<string, string[]> = { 'apps/api/src/a.ts': ['apps/api/test/a.e2e-spec.ts'], 'apps/api/src/b.ts': ['apps/api/test/b.e2e-spec.ts'], 'apps/api/src/e.ts': ['apps/api/test/e.e2e-spec.ts'] };
  return [
    {
      lane: lane('unit'),
      packageOf: (f) => (f === 'tools/d.ts' || f === 'apps/api/src/e.ts' ? undefined : api),
      find: (_p, f) => {
        calls.push(`unit:${f}`);
        return set(f, unitSpecs[f] ?? []);
      },
    },
    {
      lane: lane('e2e'),
      packageOf: (f) => (f === 'tools/d.ts' ? undefined : apiE2e),
      find: (_p, f) => {
        calls.push(`e2e:${f}`);
        return set(f, e2eSpecs[f] ?? [], 'map');
      },
    },
  ];
}
const files = ['apps/api/src/a.ts', 'apps/api/src/b.ts', 'apps/api/src/c.ts', 'tools/d.ts', 'apps/api/src/e.ts'].map(kept);

test('fallback: a later lane takes only what the unit lane left, and is not consulted otherwise', () => {
  const calls: string[] = [];
  const out = assignLanes(files, lookups(calls), 'fallback');
  assert.deepEqual(out.assignments.map((a) => [a.lane.name, a.kept.map((k) => k.file.path)]), [
    ['unit', ['apps/api/src/a.ts']],
    ['e2e', ['apps/api/src/b.ts', 'apps/api/src/e.ts']],
  ]);
  assert.deepEqual(out.viaFallback, [
    { file: 'apps/api/src/b.ts', lane: 'e2e' },
    { file: 'apps/api/src/e.ts', lane: 'e2e' },
  ]);
  assert.deepEqual(out.untested, ['apps/api/src/c.ts']);
  assert.deepEqual(out.tried.get('apps/api/src/c.ts'), ['unit', 'e2e']);
  assert.deepEqual(out.noTestConfig, ['tools/d.ts']);
  assert.ok(!calls.includes('e2e:apps/api/src/a.ts'), 'the e2e finder never ran for a file the unit lane covers');
  assert.equal(out.assignments[1]!.packages.get('apps/api/src/b.ts'), apiE2e, 'the lane keeps its own package config');
});

test('an untested file records only the lanes whose finder ran for it', () => {
  const only = lookups([]);
  only[1] = { ...only[1]!, packageOf: () => undefined };
  const out = assignLanes([kept('apps/api/src/c.ts')], only, 'fallback');
  assert.deepEqual(out.untested, ['apps/api/src/c.ts']);
  assert.deepEqual(out.tried.get('apps/api/src/c.ts'), ['unit'], 'the e2e lane had no config in the package, so it is not named');
});

test('all: every lane runs for every file it can place; nothing counts as fallback', () => {
  const out = assignLanes(files, lookups([]), 'all');
  assert.deepEqual(out.assignments.map((a) => [a.lane.name, a.kept.map((k) => k.file.path)]), [
    ['unit', ['apps/api/src/a.ts']],
    ['e2e', ['apps/api/src/a.ts', 'apps/api/src/b.ts', 'apps/api/src/e.ts']],
  ]);
  assert.deepEqual(out.viaFallback, []);
});

test('a named list runs only those lanes, for every file', () => {
  const calls: string[] = [];
  const out = assignLanes(files, lookups(calls), ['e2e']);
  assert.deepEqual(out.assignments.map((a) => a.lane.name), ['e2e']);
  assert.deepEqual(out.assignments[0]!.kept.map((k) => k.file.path), ['apps/api/src/a.ts', 'apps/api/src/b.ts', 'apps/api/src/e.ts']);
  assert.ok(calls.every((c) => c.startsWith('e2e:')));
  assert.deepEqual(out.untested, ['apps/api/src/c.ts']);
});

test('parseLaneSelection', () => {
  assert.equal(parseLaneSelection(undefined, ['unit', 'e2e']), 'fallback');
  assert.equal(parseLaneSelection('all', ['unit', 'e2e']), 'all');
  assert.deepEqual(parseLaneSelection('e2e, unit', ['unit', 'e2e']), ['e2e', 'unit']);
  assert.throws(() => parseLaneSelection('nope', ['unit', 'e2e']), /unknown lane nope; configured: unit, e2e/);
  assert.throws(() => parseLaneSelection(',', ['unit']), /needs lane names/);
});
