import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { Mutant } from '../src/mutation/types.ts';
import { findingsOf, survivorsOf, uninstrumentedFiles, untestedFindings } from '../src/report/survivors.ts';

const mutant = (over: Partial<Mutant>): Mutant => ({
  id: 'src/a.ts#1',
  file: 'src/a.ts',
  lane: 'unit',
  mutator: 'ConditionalExpression',
  start: { line: 2, column: 5 },
  end: { line: 2, column: 9 },
  replacement: 'true',
  status: 'Survived',
  statusReason: '',
  coveredBy: 3,
  isStatic: false,
  killedBy: [],
  ...over,
});

test('survivor kind follows coverage, not the engine status', () => {
  const out = survivorsOf([
    mutant({ id: 'a', status: 'Survived', coveredBy: 3 }),
    mutant({ id: 'b', status: 'Survived', coveredBy: 0 }),
    mutant({ id: 'c', status: 'NoCoverage', coveredBy: 0 }),
    mutant({ id: 'd', status: 'Killed', coveredBy: 2 }),
    mutant({ id: 'e', status: 'Survived', coveredBy: 0, isStatic: true }),
  ]);
  assert.deepEqual(out.map((s) => [s.mutant.id, s.kind]), [['a', 'weakAssertion'], ['b', 'noCoverage'], ['c', 'noCoverage'], ['e', 'static']]);
  const claims = findingsOf(out).map((f) => f.claim);
  assert.match(claims[0]!, /^3 test\(s\) reach/);
  assert.match(claims[1]!, /^No test executes/);
  assert.match(claims[3]!, /runs at module load; every test ran against/);
});

test('uninstrumentedFiles flags a file whose every run mutant survived uncovered', () => {
  const broken = [mutant({ id: 'a', file: 'src/x.ts', coveredBy: 0 }), mutant({ id: 'b', file: 'src/x.ts', coveredBy: 0, status: 'Ignored' })];
  const fine = [mutant({ id: 'c', file: 'src/y.ts', coveredBy: 0 }), mutant({ id: 'd', file: 'src/y.ts', status: 'Killed' })];
  const noCov = [mutant({ id: 'e', file: 'src/z.ts', status: 'NoCoverage', coveredBy: 0 })];
  const staticOnly = [mutant({ id: 'f', file: 'src/s.ts', coveredBy: 0, isStatic: true }), mutant({ id: 'g', file: 'src/s.ts', coveredBy: 0, isStatic: true })];
  assert.deepEqual(uninstrumentedFiles([...broken, ...fine, ...noCov, ...staticOnly]), ['src/x.ts']);
});

test('untested findings name the lanes that ran', () => {
  const files = new Map([['src/a.ts', [{ start: 3, end: 4 }] as const]]);
  const both = untestedFindings(files, () => ['unit', 'e2e'])[0]!;
  assert.equal(both.claim, 'No spec exercises src/a.ts; its 2 changed lines go unchecked by tests.');
  assert.match(both.evidence, /^no unit spec in the package imports the file .*; the e2e lane's spec sources name none$/);
  assert.equal(untestedFindings(files, () => ['e2e'])[0]!.evidence, "the e2e lane's spec sources name none");
  assert.match(untestedFindings(files)[0]!.evidence, /^no unit spec in the package imports the file/);
});
