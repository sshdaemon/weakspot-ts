import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Package, SpecSet, TriageDecision } from '../src/change/types.ts';
import { planPackages } from '../src/mutation/plan.ts';

const kept = (path: string): TriageDecision => ({ file: { path, status: 'modified', ranges: 'whole' }, kept: true, fileClass: 'logic', reason: '' });
const api: Package = { dir: '/repo/apps/api', name: 'api', testConfig: '/repo/apps/api/vitest.config.mts' };
const web: Package = { dir: '/repo/apps/web', name: 'web', testConfig: '/repo/apps/web/vitest.config.mts' };
const set = (file: string, ...specs: string[]): SpecSet => ({ file, specs, how: specs.length ? 'sibling' : 'none' });

test('planPackages groups by package and names untested and config-less files', () => {
  const files = ['apps/api/src/a.ts', 'apps/api/src/b.ts', 'apps/web/src/c.ts', 'apps/api/src/d.ts', 'tools/e.ts'];
  const out = planPackages(
    files.map(kept),
    new Map([
      ['apps/api/src/a.ts', set('apps/api/src/a.ts', 'apps/api/src/a.spec.ts')],
      ['apps/api/src/b.ts', set('apps/api/src/b.ts', 'apps/api/src/b.spec.ts', 'apps/api/src/a.spec.ts')],
      ['apps/web/src/c.ts', set('apps/web/src/c.ts', 'apps/web/src/c.test.ts')],
      ['apps/api/src/d.ts', set('apps/api/src/d.ts')],
      ['tools/e.ts', set('tools/e.ts', 'tools/e.spec.ts')],
    ]),
    new Map([
      ['apps/api/src/a.ts', api],
      ['apps/api/src/b.ts', api],
      ['apps/web/src/c.ts', web],
      ['apps/api/src/d.ts', api],
      ['tools/e.ts', undefined],
    ]),
  );
  assert.deepEqual(out.untested, ['apps/api/src/d.ts']);
  assert.deepEqual(out.noTestConfig, ['tools/e.ts']);
  assert.equal(out.plans.length, 2);
  const apiPlan = out.plans.find((p) => p.pkg.name === 'api')!;
  assert.deepEqual(apiPlan.targets.map((t) => t.file), ['apps/api/src/a.ts', 'apps/api/src/b.ts']);
  assert.deepEqual(apiPlan.specs, ['apps/api/src/a.spec.ts', 'apps/api/src/b.spec.ts']);
});
