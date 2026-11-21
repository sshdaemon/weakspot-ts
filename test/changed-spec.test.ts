import assert from 'node:assert/strict';
import { test } from 'vitest';
import { applyChangedSpecRule } from '../src/change/changed-spec.ts';
import { DEFAULT_SPEC_PATTERNS } from '../src/change/spec-kind.ts';
import { DEFAULT_SKIP } from '../src/change/triage.ts';
import type { ChangedFile, Package, SpecSet, TriageDecision } from '../src/change/types.ts';

const repoRoot = '/repo';
const pkg: Package = { dir: '/repo/app', name: 'app', testConfig: '/repo/app/vitest.config.ts' };
const changed = (path: string, ranges: ChangedFile['ranges'] = 'whole'): ChangedFile => ({ path, status: 'modified', ranges });
const kept = (f: ChangedFile): TriageDecision => ({ file: f, kept: true, fileClass: 'logic', reason: '' });
const set = (file: string, ...specs: string[]): SpecSet => ({ file, specs, how: specs.length > 0 ? 'imports' : 'none' });

const run = (files: ChangedFile[], keptFiles: ChangedFile[], specs: [string, SpecSet][], imports: Record<string, string[]>, importLines: Record<string, number[]> = {}) =>
  applyChangedSpecRule({
    repoRoot,
    changed: files,
    kept: keptFiles.map(kept),
    specs: new Map(specs),
    packages: new Map(keptFiles.map((f) => [f.path, pkg])),
    skip: DEFAULT_SKIP,
    patterns: DEFAULT_SPEC_PATTERNS,
    importsOf: (spec) => (imports[spec.path] ? { pkg, imports: imports[spec.path]! } : undefined),
    importLines: (spec) => new Set(importLines[spec.path] ?? []),
    onlyImports: (text) => text.split('\n').every((l) => !l.trim() || l.startsWith('import ')),
  });

test('a changed spec adds the sources it imports, whole, with itself as the spec set', () => {
  const out = run([changed('app/src/a.test.ts')], [], [], { 'app/src/a.test.ts': ['/repo/app/src/a.ts', '/repo/app/src/b.ts'] });
  assert.deepEqual(out.viaChangedSpec, ['app/src/a.ts', 'app/src/b.ts']);
  assert.deepEqual(out.kept.map((d) => [d.file.path, d.file.ranges]), [['app/src/a.ts', 'whole'], ['app/src/b.ts', 'whole']]);
  assert.deepEqual(out.specs.get('app/src/a.ts'), { file: 'app/src/a.ts', specs: ['app/src/a.test.ts'], how: 'imports' });
  assert.equal(out.packages.get('app/src/b.ts'), pkg);
});

test('an already-changed source keeps its ranges and gains the spec; an untested one becomes "imports"', () => {
  const a = changed('app/src/a.ts', [{ start: 3, end: 5 }]);
  const out = run([a, changed('app/src/a.test.ts')], [a], [['app/src/a.ts', set('app/src/a.ts')]], { 'app/src/a.test.ts': ['/repo/app/src/a.ts'] });
  assert.deepEqual(out.viaChangedSpec, []);
  assert.deepEqual(out.kept.map((d) => d.file.ranges), [[{ start: 3, end: 5 }]]);
  assert.deepEqual(out.specs.get('app/src/a.ts'), { file: 'app/src/a.ts', specs: ['app/src/a.test.ts'], how: 'imports' });
});

test('imports outside the package, skipped by triage, other specs, and e2e specs are ignored; two specs merge', () => {
  const out = run(
    [changed('app/src/a.test.ts'), changed('app/src/b.test.ts'), changed('app/test/x.e2e-spec.ts')],
    [],
    [],
    {
      'app/src/a.test.ts': ['/repo/other/src/z.ts', '/repo/app/src/a.dto.ts', '/repo/app/src/a.spec.ts', '/repo/app/test/helper.ts', '/repo/app/src/shared.ts'],
      'app/src/b.test.ts': ['/repo/app/src/shared.ts'],
      'app/test/x.e2e-spec.ts': ['/repo/app/src/e2e-only.ts'],
    },
  );
  assert.deepEqual(out.viaChangedSpec, ['app/src/shared.ts']);
  assert.deepEqual(out.specs.get('app/src/shared.ts')?.specs, ['app/src/a.test.ts', 'app/src/b.test.ts']);
});

test('a changed spec with no known package adds nothing', () => {
  const out = run([changed('app/src/a.test.ts')], [], [], {});
  assert.deepEqual(out.viaChangedSpec, []);
  assert.deepEqual(out.kept, []);
});

test('a spec whose changed lines are all imports or blank lines changed no test and widens nothing', () => {
  const imports = { 'app/src/a.test.ts': ['/repo/app/src/a.ts'] };
  const lines = { 'app/src/a.test.ts': [1, 2, 3, 5] };
  const onlyImports = run([changed('app/src/a.test.ts', [{ start: 1, end: 3 }, { start: 5, end: 5 }])], [], [], imports, lines);
  assert.deepEqual(onlyImports.viaChangedSpec, []);
  assert.deepEqual(onlyImports.importOnly, ['app/src/a.test.ts']);
  const withTest = run([changed('app/src/a.test.ts', [{ start: 2, end: 4 }])], [], [], imports, lines);
  assert.deepEqual(withTest.viaChangedSpec, ['app/src/a.ts'], 'line 4 is a test line');
  assert.deepEqual(withTest.importOnly, []);
  const added = run([changed('app/src/a.test.ts', 'whole')], [], [], imports, lines);
  assert.deepEqual(added.viaChangedSpec, ['app/src/a.ts'], 'a new spec is never import-only');
});

test('import-only needs every changed range inside the imports, and blank lines may hold spaces', () => {
  const imports = { 'app/src/a.test.ts': ['/repo/app/src/a.ts'] };
  const out = run([changed('app/src/a.test.ts', [{ start: 1, end: 1 }, { start: 4, end: 4 }])], [], [], imports, { 'app/src/a.test.ts': [1, 2] });
  assert.deepEqual(out.viaChangedSpec, ['app/src/a.ts'], 'line 4 is a test line even though line 1 is an import');
});

test('a removed test makes a spec changed, even when the only added line is an import', () => {
  const imports = { 'app/src/a.test.ts': ['/repo/app/src/a.ts'] };
  const lines = { 'app/src/a.test.ts': [1] };
  const droppedTest = run([{ ...changed('app/src/a.test.ts', [{ start: 1, end: 1 }]), removed: ["test('b', () => {", '  expect(b()).toBe(1);', '});'] }], [], [], imports, lines);
  assert.deepEqual(droppedTest.viaChangedSpec, ['app/src/a.ts']);
  const droppedImport = run([{ ...changed('app/src/a.test.ts', [{ start: 1, end: 1 }]), removed: ["import { b } from './b';", ''] }], [], [], imports, lines);
  assert.deepEqual(droppedImport.importOnly, ['app/src/a.test.ts'], 'removing an import alone is still import-only');
  const onlyRemoved = run([{ ...changed('app/src/a.test.ts', []), removed: ["test('b', () => {});"] }], [], [], imports, lines);
  assert.deepEqual(onlyRemoved.viaChangedSpec, ['app/src/a.ts'], 'a spec change that only deletes a test counts');
});
