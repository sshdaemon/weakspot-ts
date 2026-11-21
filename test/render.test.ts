import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { Mutant } from '../src/mutation/types.ts';
import { renderMarkdown } from '../src/report/render.ts';
import type { Report, Survivor } from '../src/report/types.ts';

const mutant = (over: Partial<Mutant>): Mutant => ({
  id: 'x',
  file: 'src/a.ts',
  lane: 'unit',
  mutator: 'ConditionalExpression',
  start: { line: 3, column: 5 },
  end: { line: 3, column: 9 },
  original: 'x',
  replacement: 'true',
  status: 'Survived',
  statusReason: '',
  coveredBy: 2,
  isStatic: false,
  killedBy: [],
  ...over,
});

const base: Report = {
  tool: 'weakspot-ts',
  version: 't',
  createdAt: '2026-11-12T00:00:00.000Z',
  repo: '/repo',
  command: 'weakspot diff',
  change: { kind: 'diff', detail: 'origin/main' },
  packages: [
    { lane: 'unit', escalated: false, name: 'app', dir: 'app', targets: ['src/a.ts'], specs: ['src/a.test.ts'], testCount: 4, durationMs: 1500, counts: { Killed: 5, Survived: 2, NoCoverage: 1, CompileError: 1, RuntimeError: 1 }, artifacts: {} },
    { lane: 'e2e', escalated: true, name: 'app', dir: 'app', targets: ['src/b.ts'], specs: ['e2e/b.e2e.ts'], testCount: 1, durationMs: 20_000, counts: {}, artifacts: {} },
  ],
  dropped: [{ path: 'src/a.dto.ts', reason: 'matches skip pattern' }],
  untested: ['src/c.ts'],
  viaChangedSpec: ['src/d.ts'],
  importOnlySpecs: ['src/g.test.ts'],
  viaFallback: [{ file: 'src/b.ts', lane: 'e2e' }],
  noTestConfig: ['tools/e.ts'],
  warnings: ['src/f.ts: produced no mutants'],
  mutants: [],
  survivors: [],
  killedLater: [],
  accepted: [],
  findings: [],
};

test('renderMarkdown: package rows, every section in order, survivor wording per kind and lane', () => {
  const survivors: Survivor[] = [
    { kind: 'weakAssertion', mutant: mutant({}) },
    { kind: 'noCoverage', mutant: mutant({ start: { line: 7, column: 1 }, coveredBy: 0, replacement: '  a\n  b ' }) },
    { kind: 'static', mutant: mutant({ start: { line: 1, column: 1 }, isStatic: true, replacement: '' }) },
    { kind: 'weakAssertion', mutant: mutant({ file: 'src/b.ts', lane: 'e2e', coveredBy: 1 }) },
  ];
  const md = renderMarkdown({
    ...base,
    survivors: [...survivors, { kind: 'weakAssertion', mutant: mutant({ start: { line: 4, column: 2 } }), noise: 'logging' }, { kind: 'weakAssertion', mutant: mutant({ start: { line: 9, column: 1 } }), accepted: { reason: 'r', date: 'd' } }],
    accepted: [{ id: 'src/a.ts#ConditionalExpression#0123456789ab', where: 'src/a.ts:9:1', reason: 'equivalent', date: '2026-11-21T10:00:00.000Z' }],
  });
  assert.match(md, /\| unit \| app \| 1 \| 1 \| 4 \| 10 \| 5 \| 2 \| 1 \| 0 \| 2 \| 0 \| 1\.5s \|/);
  assert.match(md, /\| e2e \(retry\) \| app \| 1 \| 1 \| 1 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 20\.0s \|/);
  const headings = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(headings, [
    'Packages',
    'Untested (no spec found, not mutated)',
    'Mutated whole because a spec that imports them changed',
    'Changed specs whose edit touched only imports (their sources not mutated for them)',
    'No unit spec, checked by a later lane',
    'No test config found',
    'Warnings',
    'Skipped by triage',
    'Survivors (4)',
    'Noise (1, not findings: logging 1)',
    'Accepted (not findings)',
  ]);
  assert.match(md, /- src\/a\.ts:9:1 `src\/a\.ts#ConditionalExpression#0123456789ab`: equivalent \(2026-11-21\)/);
  assert.doesNotMatch(md, /L9:1/, 'an accepted survivor is not listed as a survivor');
  assert.match(md, /## Noise \(1, not findings: logging 1\)\n\n- L4:2 ConditionalExpression → `true` \(2 covering test\(s\), none fails\) \[logging\] in src\/a\.ts$/m);
  assert.match(md, /- src\/b\.ts: e2e lane/);
  assert.doesNotMatch(md, /None\./, '"None." only when there are no survivors');
  assert.match(md, /- src\/a\.dto\.ts: matches skip pattern/);
  assert.match(md, /### src\/a\.ts\n\n- L3:5 ConditionalExpression → `true` \(2 covering test\(s\), none fails\)/);
  assert.match(md, /- L7:1 ConditionalExpression → `a b` \(no test reaches this line\)/);
  assert.match(md, /- L1:1 ConditionalExpression → `\(removed\)` \(static: every test ran against it, none fails\)/);
  assert.match(md, /### src\/b\.ts \(e2e lane\)\n\n- L3:5 .*\(1 covering test\(s\), none fails\)/);
});

test('renderMarkdown: empty sections are left out and no survivors reads "None."', () => {
  const md = renderMarkdown({ ...base, packages: [], untested: [], viaChangedSpec: [], importOnlySpecs: [], viaFallback: [], noTestConfig: [], warnings: [], dropped: [] });
  assert.equal(
    md,
    [
      '# weakspot report',
      '',
      'Repo: /repo  ',
      'Change: diff (origin/main)  ',
      'Run: 2026-11-12T00:00:00.000Z  ',
      'Command: `weakspot diff`',
      '',
      '## Packages',
      '',
      '| Lane | Package | Files | Specs | Tests | Mutants | Killed | Survived | No coverage | Timeout | Errors | Ignored | Time |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      '',
      '## Survivors (0)',
      '',
      'None.',
    ].join('\n'),
  );
});

test('renderMarkdown: survivors killed in a later lane get their own section; one that survives there says so', () => {
  const md = renderMarkdown({
    ...base,
    survivors: [{ kind: 'noCoverage', mutant: mutant({ coveredBy: 0 }), escalated: { lane: 'e2e', status: 'Survived', coveredBy: 3 } }, { kind: 'noCoverage', mutant: mutant({ coveredBy: 0, start: { line: 8, column: 2 } }), escalated: { lane: 'e2e', status: 'RuntimeError', coveredBy: 0 } }],
    killedLater: [{ id: 'src/a.ts#ConditionalExpression#0123456789ab', where: 'src/a.ts:7:1', lane: 'e2e' }],
  });
  assert.match(md, /\(no test reaches this line; also survives in the e2e lane with 3 covering test\(s\)\)/);
  assert.match(md, /- L8:2 .*\(no test reaches this line; ended as RuntimeError in the e2e lane, so that lane could not judge it\)/);
  assert.match(md, /## Killed in a later lane \(unit tests miss them, not findings\)\n\n- src\/a\.ts:7:1 `src\/a\.ts#ConditionalExpression#0123456789ab`: e2e lane/);
});
