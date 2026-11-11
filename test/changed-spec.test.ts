import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyChangedSpecRule } from '../src/change/changed-spec.ts';
import { DEFAULT_SPEC_PATTERNS } from '../src/change/spec-kind.ts';
import { DEFAULT_SKIP } from '../src/change/triage.ts';
import type { ChangedFile, Package, SpecSet, TriageDecision } from '../src/change/types.ts';

const repoRoot = '/repo';
const pkg: Package = { dir: '/repo/app', name: 'app', testConfig: '/repo/app/vitest.config.ts' };
const changed = (path: string, ranges: ChangedFile['ranges'] = 'whole'): ChangedFile => ({ path, status: 'modified', ranges });
const kept = (f: ChangedFile): TriageDecision => ({ file: f, kept: true, fileClass: 'logic', reason: '' });
const set = (file: string, ...specs: string[]): SpecSet => ({ file, specs, how: specs.length ? 'imports' : 'none' });

const run = (files: ChangedFile[], keptFiles: ChangedFile[], specs: [string, SpecSet][], imports: Record<string, string[]>) =>
  applyChangedSpecRule({
    repoRoot,
    changed: files,
    kept: keptFiles.map(kept),
    specs: new Map(specs),
    packages: new Map(keptFiles.map((f) => [f.path, pkg])),
    skip: DEFAULT_SKIP,
    patterns: DEFAULT_SPEC_PATTERNS,
    importsOf: (spec) => (imports[spec.path] ? { pkg, imports: imports[spec.path]! } : undefined),
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
