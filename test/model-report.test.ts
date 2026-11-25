import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { JsonMutantCache } from '../src/adapters/fs/mutant-cache.ts';
import { summaryLine } from '../src/cli/main.ts';
import type { Mutant } from '../src/mutation/types.ts';
import { emptyReport, mergeModel } from '../src/report/merge.ts';
import { renderMarkdown } from '../src/report/render.ts';
import { findingsOf, survivorsOf } from '../src/report/survivors.ts';
import type { PackageSummary, Report } from '../src/report/types.ts';

const mutant = (over: Partial<Mutant>): Mutant => ({
  id: 'x',
  file: 'src/a.ts',
  lane: 'unit',
  mutator: 'ConditionalExpression',
  start: { line: 3, column: 5 },
  end: { line: 3, column: 9 },
  original: 'a > 1',
  replacement: 'true',
  status: 'Survived',
  statusReason: '',
  coveredBy: 2,
  isStatic: false,
  killedBy: [],
  ...over,
});

const model = (replacement: string, because: string): Mutant => mutant({ id: `m-${replacement}`, mutator: 'model', replacement, because, coveredBy: 4, scope: 'f' });
const pkg = (over: Partial<PackageSummary>): PackageSummary => ({ lane: 'unit', escalated: false, name: 'app', dir: 'app', targets: ['src/a.ts'], specs: [], testCount: 4, durationMs: 800, counts: { Survived: 1 }, artifacts: {}, ...over });
const summary = (rejected: number) => ({
  command: 'weakspot run --mutants a.json',
  createdAt: '2026-11-21T00:00:00.000Z',
  placeholders: '/out/placeholders.json',
  mutants: '/out/mutants.json',
  rejected: Array.from({ length: rejected }, (_, i) => ({ placeholder: `p${i}`, replacement: 'x', reason: 'identical to the original' })),
});

function withModel(base: Report, mutants: Mutant[], rejected = 0): Report {
  const survivors = survivorsOf(mutants);
  return mergeModel(base, { mutants, survivors, accepted: [], packages: [pkg({ model: true, counts: { Survived: survivors.length } })], summary: summary(rejected) });
}

test('model findings name the change and the author\'s reading, and carry it in the mutant', () => {
  const [finding] = findingsOf(survivorsOf([model('a >= 1', 'one more user passes the check.')]));
  assert.equal(finding!.claim, 'No test fails when src/a.ts:3 becomes `a >= 1`: one more user passes the check.');
  assert.equal(finding!.mutant!.because, 'one more user passes the check.');
  assert.match(finding!.id, /^src\/a\.ts#model#[0-9a-f]{12}$/);
  assert.equal(findingsOf(survivorsOf([mutant({})]))[0]!.mutant!.because, undefined, 'operator findings have no reading');
});

test('merge: a second run replaces the first run\'s model results and leaves everything else as it was', () => {
  const operator = survivorsOf([mutant({})]);
  const base: Report = {
    ...emptyReport({ version: 't', repo: '/r', command: 'weakspot diff', change: { kind: 'diff', detail: 'main' } }),
    packages: [pkg({})],
    untested: ['src/u.ts'],
    mutants: [mutant({})],
    survivors: operator,
    accepted: [{ id: 'src/b.ts#untested', where: 'src/b.ts', reason: 'r', date: 'd' }],
    findings: findingsOf(operator),
  };
  const first = withModel(base, [model('a >= 1', 'one'), model('a < 1', 'two')], 2);
  const firstFinding = first.findings.find((f) => f.mutant?.mutator === 'model')!;
  const accepted = mergeModel(first, { ...first, mutants: [], survivors: [], packages: [], accepted: [{ id: firstFinding.id, where: 'src/a.ts:3:5', reason: 'equivalent', date: 'd' }], summary: summary(0) });
  assert.deepEqual(accepted.accepted.map((a) => a.id), ['src/b.ts#untested', firstFinding.id]);
  const second = withModel(accepted, [model('false', 'three')]);
  assert.deepEqual(second.packages.map((p) => Boolean(p.model)), [false, true]);
  assert.deepEqual(second.mutants.map((m) => m.mutator), ['ConditionalExpression', 'model']);
  assert.deepEqual(second.survivors.map((s) => s.mutant.replacement), ['true', 'false']);
  assert.deepEqual(second.findings.map((f) => f.mutant!.replacement), ['true', 'false']);
  assert.deepEqual(second.accepted.map((a) => a.id), ['src/b.ts#untested']);
  assert.deepEqual([second.untested, second.command, second.model!.rejected.length], [['src/u.ts'], 'weakspot diff', 0]);
});

test('render: the model line under the header, the lane marked, the reading on each survivor, rejections listed', () => {
  const r = withModel(emptyReport({ version: 't', repo: '/r', command: 'weakspot propose', change: { kind: 'files', detail: 'a.ts' } }), [model('a >= 1', 'one more user passes')], 1);
  const md = renderMarkdown(r);
  assert.match(md, /Command: `weakspot propose`  \nModel mutants: `weakspot run --mutants a\.json` at 2026-11-21T00:00:00\.000Z, 1 answer\(s\) rejected; replay with `weakspot run --mutants \/out\/mutants\.json`\n/);
  assert.match(md, /\| unit \(model\) \| app \|/);
  assert.match(md, /- L3:5 model → `a >= 1` \(4 test\(s\) ran, none fails\): one more user passes\n/);
  assert.match(md, /## Rejected model mutants \(not run\)\n\n- `p0` → `x`: identical to the original/);
  assert.doesNotMatch(renderMarkdown(emptyReport({ version: 't', repo: '/r', command: 'c', change: { kind: 'files', detail: 'a.ts' } })), /Model mutants|Rejected/);
});

test('summary line counts rejected model answers only when there are some', () => {
  const base = emptyReport({ version: 't', repo: '/r', command: 'c', change: { kind: 'files', detail: 'a.ts' } });
  assert.equal(summaryLine(withModel(base, [model('x', 'y')], 2), 1000), '1 package(s), 1 mutants, 0 killed, 1 survivor(s), 0 untested file(s), 2 model answer(s) rejected, 1.0s');
  assert.equal(summaryLine(withModel(base, [model('x', 'y')], 0), 1000), '1 package(s), 1 mutants, 0 killed, 1 survivor(s), 0 untested file(s), 1.0s');
});

test('mutant cache: entries per repo, replaced per placeholder; a missing or broken file reads as empty', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'weakspot-cache-'));
  try {
    const cache = new JsonMutantCache(dir);
    assert.equal(cache.get('org/r', 'p'), undefined);
    cache.put('org/r', new Map([['p', [{ replacement: 'a', because: 'b' }]], ['q', [{ replacement: 'c', because: 'd' }]]]));
    cache.put('org/r', new Map([['p', [{ replacement: 'e', because: 'f' }]]]));
    cache.put('org/r', new Map());
    const fresh = new JsonMutantCache(dir);
    assert.deepEqual([fresh.get('org/r', 'p'), fresh.get('org/r', 'q'), fresh.get('other', 'p')], [[{ replacement: 'e', because: 'f' }], [{ replacement: 'c', because: 'd' }], undefined]);
    writeFileSync(path.join(dir, 'org_r.json'), JSON.stringify({ q: [{ replacement: 'changed', because: 'on disk' }] }));
    assert.deepEqual(fresh.get('org/r', 'q'), [{ replacement: 'c', because: 'd' }], 'a cache reads its file once');
    writeFileSync(path.join(dir, 'org_r.json'), JSON.stringify([[{ replacement: 'a', because: 'b' }]]));
    assert.equal(new JsonMutantCache(dir).get('org/r', '0'), undefined, 'a top-level array is not a cache');
    writeFileSync(path.join(dir, 'org_r.json'), JSON.stringify({ p: { replacement: 'a', because: 'b' }, q: [null, 'x'] }));
    assert.deepEqual([new JsonMutantCache(dir).get('org/r', 'p'), new JsonMutantCache(dir).get('org/r', 'q')], [undefined, undefined]);
    writeFileSync(path.join(dir, 'org_r.json'), '{ broken');
    assert.equal(new JsonMutantCache(dir).get('org/r', 'p'), undefined);
    writeFileSync(path.join(dir, 'org_r.json'), JSON.stringify({ p: [{ replacement: 1 }], q: [{ replacement: 'x', because: 'y' }] }));
    assert.deepEqual([new JsonMutantCache(dir).get('org/r', 'p'), new JsonMutantCache(dir).get('org/r', 'q')], [undefined, [{ replacement: 'x', because: 'y' }]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
