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
    { lane: 'unit', name: 'app', dir: 'app', targets: ['src/a.ts'], specs: ['src/a.test.ts'], testCount: 4, durationMs: 1500, counts: { Killed: 5, Survived: 2, NoCoverage: 1, CompileError: 1, RuntimeError: 1 }, artifacts: {} },
    { lane: 'e2e', name: 'app', dir: 'app', targets: ['src/b.ts'], specs: ['e2e/b.e2e.ts'], testCount: 1, durationMs: 20000, counts: {}, artifacts: {} },
  ],
  dropped: [{ path: 'src/a.dto.ts', reason: 'matches skip pattern' }],
  untested: ['src/c.ts'],
  viaChangedSpec: ['src/d.ts'],
  viaFallback: [{ file: 'src/b.ts', lane: 'e2e' }],
  noTestConfig: ['tools/e.ts'],
  warnings: ['src/f.ts: produced no mutants'],
  mutants: [],
  survivors: [],
  findings: [],
};

test('renderMarkdown: package rows, every section in order, survivor wording per kind and lane', () => {
  const survivors: Survivor[] = [
    { kind: 'weakAssertion', mutant: mutant({}) },
    { kind: 'noCoverage', mutant: mutant({ start: { line: 7, column: 1 }, coveredBy: 0, replacement: '  a\n  b ' }) },
    { kind: 'static', mutant: mutant({ start: { line: 1, column: 1 }, isStatic: true, replacement: '' }) },
    { kind: 'weakAssertion', mutant: mutant({ file: 'src/b.ts', lane: 'e2e', coveredBy: 1 }) },
  ];
  const md = renderMarkdown({ ...base, survivors });
  assert.match(md, /\| unit \| app \| 1 \| 1 \| 4 \| 10 \| 5 \| 2 \| 1 \| 0 \| 2 \| 0 \| 1\.5s \|/);
  assert.match(md, /\| e2e \| app \| 1 \| 1 \| 1 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 20\.0s \|/);
  const headings = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(headings, [
    'Packages',
    'Untested (no spec found, not mutated)',
    'Mutated whole because a spec that imports them changed',
    'No unit spec, checked by a later lane',
    'No test config found',
    'Warnings',
    'Skipped by triage',
    'Survivors (4)',
  ]);
  assert.match(md, /- src\/b\.ts: e2e lane/);
  assert.doesNotMatch(md, /None\./, '"None." only when there are no survivors');
  assert.match(md, /- src\/a\.dto\.ts: matches skip pattern/);
  assert.match(md, /### src\/a\.ts\n\n- L3:5 ConditionalExpression → `true` \(2 covering test\(s\), none fails\)/);
  assert.match(md, /- L7:1 ConditionalExpression → `a b` \(no test reaches this line\)/);
  assert.match(md, /- L1:1 ConditionalExpression → `\(removed\)` \(static: every test ran against it, none fails\)/);
  assert.match(md, /### src\/b\.ts \(e2e lane\)\n\n- L3:5 .*\(1 covering test\(s\), none fails\)/);
});

test('renderMarkdown: empty sections are left out and no survivors reads "None."', () => {
  const md = renderMarkdown({ ...base, packages: [], untested: [], viaChangedSpec: [], viaFallback: [], noTestConfig: [], warnings: [], dropped: [] });
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
