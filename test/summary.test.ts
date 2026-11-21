import assert from 'node:assert/strict';
import { test } from 'vitest';
import { summaryLine } from '../src/cli/main.ts';
import type { Mutant } from '../src/mutation/types.ts';
import type { PackageSummary, Report, Survivor } from '../src/report/types.ts';

const pkg = (escalated: boolean, counts: Record<string, number>): PackageSummary => ({ lane: escalated ? 'e2e' : 'unit', escalated, name: 'p', dir: '.', targets: [], specs: [], testCount: 0, durationMs: 0, counts, artifacts: {} });
const s = (over: Partial<Survivor> = {}): Survivor => ({ kind: 'weakAssertion', mutant: {} as Mutant, ...over });

test('summary line: first-pass mutants only, kills in a later lane, noise and accepted counted apart, accepted untested files subtracted', () => {
  const report = {
    packages: [pkg(false, { Killed: 5, Timeout: 1, Survived: 4 }), pkg(true, { Killed: 3, Survived: 1 })],
    survivors: [s(), s({ noise: 'logging' }), s({ accepted: { reason: 'r', date: 'd' } }), s({ noise: 'logging', accepted: { reason: 'r', date: 'd' } })],
    killedLater: [{ id: 'a', where: 'a', lane: 'e2e' }, { id: 'b', where: 'b', lane: 'e2e' }],
    accepted: [{ id: 'x.ts#untested', where: 'x.ts', reason: 'r', date: 'd' }, { id: 'y.ts#M#0123456789ab', where: 'y.ts:1:1', reason: 'r', date: 'd' }],
    untested: ['x.ts', 'z.ts'],
    warnings: [],
  } as unknown as Report;
  assert.equal(summaryLine(report, 1500), '2 package(s), 10 mutants, 6 killed, 1 survivor(s) (and 2 killed in a later lane, 1 noise, 3 accepted), 1 untested file(s), 1.5s');
});
