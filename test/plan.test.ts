import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Package, SpecSet, TriageDecision } from '../src/change/types.ts';
import { planPackages } from '../src/mutation/plan.ts';

const kept = (path: string): TriageDecision => ({ file: { path, status: 'modified', ranges: 'whole' }, kept: true, fileClass: 'logic', reason: '' });

const api: Package = { dir: '/repo/services/api', name: 'api', testConfig: '/repo/services/api/vitest.config.mts' };
const web: Package = { dir: '/repo/services/web', name: 'web', testConfig: '/repo/services/web/vitest.config.mts' };
const set = (file: string, ...specs: string[]): SpecSet => ({ file, specs, how: specs.length ? 'imports' : 'none' });

test('planPackages groups by package and names untested and config-less files', () => {
  const files = ['services/api/src/a.ts', 'services/api/src/b.ts', 'services/web/src/c.ts', 'services/api/src/d.ts', 'tools/e.ts', 'tools/f.ts'];
  const out = planPackages(
    files.map(kept),
    new Map([
      ['services/api/src/a.ts', set('services/api/src/a.ts', 'services/api/src/a.spec.ts')],
      ['services/api/src/b.ts', set('services/api/src/b.ts', 'services/api/src/b.spec.ts', 'services/api/src/a.spec.ts')],
      ['services/web/src/c.ts', set('services/web/src/c.ts', 'services/web/src/c.test.ts')],
      ['services/api/src/d.ts', set('services/api/src/d.ts')],
      ['tools/e.ts', set('tools/e.ts', 'tools/e.spec.ts')],
      ['tools/f.ts', set('tools/f.ts')],
    ]),
    new Map([
      ['services/api/src/a.ts', api],
      ['services/api/src/b.ts', api],
      ['services/web/src/c.ts', web],
      ['services/api/src/d.ts', api],
      ['tools/e.ts', undefined],
      ['tools/f.ts', undefined],
    ]),
  );
  assert.deepEqual(out.untested, ['services/api/src/d.ts']);
  assert.deepEqual(out.noTestConfig, ['tools/e.ts', 'tools/f.ts'], 'no known test config wins over an empty spec set: discovery never ran');
  assert.equal(out.plans.length, 2);
  const apiPlan = out.plans.find((p) => p.pkg.name === 'api')!;
  assert.deepEqual(apiPlan.targets.map((t) => t.file), ['services/api/src/a.ts', 'services/api/src/b.ts']);
  assert.deepEqual(apiPlan.specs, ['services/api/src/a.spec.ts', 'services/api/src/b.spec.ts']);
});
