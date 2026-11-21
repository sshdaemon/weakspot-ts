import assert from 'node:assert/strict';
import { test } from 'vitest';
import { escalationTargets, sameMutant } from '../src/mutation/escalation.ts';
import type { Mutant } from '../src/mutation/types.ts';

const m = (file: string, line: number, over: Partial<Mutant> = {}): Mutant => ({
  id: `${file}#${line}`, file, lane: 'unit', mutator: 'ConditionalExpression', start: { line, column: 3 }, end: { line, column: 9 },
  original: 'a > 1', replacement: 'true', status: 'NoCoverage', statusReason: '', coveredBy: 0, isStatic: false, killedBy: [], ...over,
});

const span = (line: number, endLine = line) => ({ start: { line, column: 3 }, end: { line: endLine, column: 9 } });

test('escalationTargets: untested retries nothing, noCoverage only uncovered unit survivors, survivors every unit survivor; exact spans, once each, in file order', () => {
  const longer = { start: { line: 3, column: 3 }, end: { line: 3, column: 20 } };
  const survivors = [m('a.ts', 4), m('a.ts', 3), m('a.ts', 3, { id: 'twin', mutator: 'EqualityOperator' }), m('a.ts', 3, { id: 'longer', mutator: 'LogicalOperator', end: longer.end }), m('a.ts', 9, { status: 'Survived', coveredBy: 2 }), m('b.ts', 1, { end: { line: 2, column: 9 } }), m('c.ts', 5, { lane: 'e2e' })];
  assert.deepEqual(escalationTargets(survivors, 'untested'), new Map());
  assert.deepEqual(escalationTargets(survivors, 'noCoverage'), new Map([['a.ts', [span(3), longer, span(4)]], ['b.ts', [span(1, 2)]]]), 'a span sharing only its start is its own target');
  assert.deepEqual(escalationTargets(survivors, 'survivors'), new Map([['a.ts', [span(3), longer, span(4), span(9)]], ['b.ts', [span(1, 2)]]]));
});

test('sameMutant: same file, mutator, span and replacement, whatever the lane, id or status', () => {
  const a = m('a.ts', 3);
  assert.ok(sameMutant(a, { ...a, id: 'other', lane: 'e2e', status: 'Killed', coveredBy: 4 }));
  for (const over of [{ file: 'b.ts' }, { mutator: 'EqualityOperator' }, { replacement: 'false' }, { start: { line: 3, column: 4 } }, { end: { line: 3, column: 8 } }, { end: { line: 4, column: 9 } }] as Partial<Mutant>[]) {
    assert.ok(!sameMutant(a, { ...a, ...over }), JSON.stringify(over));
  }
});
