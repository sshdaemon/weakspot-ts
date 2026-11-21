import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, test } from 'vitest';
import { JsonSuppressionStore, SuppressionStoreError } from '../src/adapters/fs/suppression-store.ts';
import type { Mutant } from '../src/mutation/types.ts';
import { isAcceptableId, survivorId, untestedId } from '../src/report/suppressions.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'weakspot-accepted-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const m = (over: Partial<Mutant> = {}): Mutant => ({
  id: 'run-1', file: 'src/a.ts', lane: 'unit', mutator: 'EqualityOperator', start: { line: 3, column: 7 }, end: { line: 3, column: 12 },
  original: 'a < b', replacement: 'a <= b', status: 'Survived', statusReason: '', coveredBy: 1, isStatic: false, killedBy: [], ...over,
});

test('survivorId: file, mutator and a text hash; the line, lane and run id do not count', () => {
  const id = survivorId(m());
  assert.match(id, /^src\/a\.ts#EqualityOperator#[0-9a-f]{12}$/);
  assert.equal(survivorId(m({ id: 'run-2', lane: 'e2e', start: { line: 40, column: 1 }, end: { line: 40, column: 6 } })), id);
  assert.notEqual(survivorId(m({ replacement: 'a > b' })), id);
  assert.notEqual(survivorId(m({ original: 'a < c' })), id);
  assert.notEqual(survivorId(m({ mutator: 'ConditionalExpression' })), id);
  assert.notEqual(survivorId(m({ file: 'src/b.ts' })), id);
  assert.notEqual(survivorId(m({ scope: 'Svc.run' })), id, 'the same text in another function is another survivor');
  assert.notEqual(survivorId(m({ scope: 'Svc.run' })), survivorId(m({ scope: 'Svc.stop' })), 'two functions, two ids');
  assert.equal(survivorId(m({ scope: 'Svc.run' })), `src/a.ts#EqualityOperator#${createHash('sha1').update('Svc.run\0a < b\0a <= b').digest('hex').slice(0, 12)}`, 'the id is pinned to scope, original and replacement');
  assert.equal(survivorId(m({ scope: 'Svc.run', start: { line: 90, column: 1 } })), survivorId(m({ scope: 'Svc.run' })));
  assert.notEqual(survivorId(m({ original: 'a <', replacement: ' b' })), survivorId(m({ original: 'a', replacement: '< b' })), 'the separator keeps the two texts apart');
});

test('isAcceptableId takes survivor and untested ids only', () => {
  assert.ok(isAcceptableId(survivorId(m())));
  assert.ok(isAcceptableId(untestedId('src/pages/[id]/a.ts')));
  for (const bad of ['src/a.ts', 'src/a.ts#EqualityOperator', 'src/a.ts#EqualityOperator#xyz', '#untested', 'src/a.ts#untested#1']) assert.ok(!isAcceptableId(bad), bad);
});

test('the store keeps entries per repo, replaces by id, revokes, and refuses a malformed file', () => {
  const file = path.join(dir, 'nested', 'accepted.json');
  const store = new JsonSuppressionStore(file);
  assert.deepEqual(store.list('r'), []);
  store.accept({ repo: 'r', id: 'a#untested', reason: 'one', date: 'd1' });
  store.accept({ repo: 'other', id: 'a#untested', reason: 'two', date: 'd1' });
  store.accept({ repo: 'r', id: 'a#untested', reason: 'three', date: 'd2' });
  assert.deepEqual(store.list('r'), [{ repo: 'r', id: 'a#untested', reason: 'three', date: 'd2' }]);
  assert.equal(store.list('other').length, 1);
  store.accept({ repo: 'r', id: 'b#untested', reason: 'four', date: 'd3' });
  assert.equal(store.revoke('r', 'a#untested'), true);
  assert.deepEqual(store.list('r').map((e) => e.id), ['b#untested'], 'revoking one id keeps the others of the repo');
  store.accept({ repo: 'r', id: 'b#untested', reason: 'five', date: 'd4' });
  assert.deepEqual(store.list('r').map((e) => e.reason), ['five'], 'accepting one id replaces only that id');
  store.revoke('r', 'b#untested');
  assert.equal(store.revoke('r', 'a#untested'), false);
  assert.deepEqual(new JsonSuppressionStore(file).list('other').map((e) => e.reason), ['two'], 'what was written is read back');
  assert.match(readFileSync(file, 'utf8'), /^\{\n  "entries": \[/);
  writeFileSync(file, '{"entries": [{"repo": "r", "id": "x#untested", "reason": "y", "date": "z"}, null]}');
  assert.throws(() => store.list('r'), SuppressionStoreError, 'one bad entry among good ones still fails');
  writeFileSync(file, '{"entries": ["text"]}');
  assert.throws(() => store.list('r'), SuppressionStoreError);
  writeFileSync(file, '{"entries": [{"repo": "r"}]}');
  assert.throws(() => store.list('r'), (err: unknown) => err instanceof SuppressionStoreError && /expected \{ "entries"/.test(err.message));
  writeFileSync(file, 'nope');
  assert.throws(() => store.list('r'), /not valid JSON/);
});
