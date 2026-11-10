import assert from 'node:assert/strict';
import { test } from 'node:test';
import { triage } from '../src/change/triage.ts';

const file = (path: string) => ({ path, status: 'modified' as const, ranges: 'whole' as const });

test('triage drops dtos, modules, barrels, specs and non-TypeScript, keeps services and components', () => {
  const out = triage([
    file('services/api/src/invoice/invoice.dto.ts'),
    file('services/api/src/invoice/invoice.module.ts'),
    file('services/api/src/invoice/index.ts'),
    file('services/api/src/invoice/invoice.service.spec.ts'),
    file('services/api/test/e2e/invoice.e2e-spec.ts'),
    file('services/api/src/invoice/invoice.service.ts'),
    file('src/components/Price.tsx'),
    file('README.md'),
  ]);
  assert.deepEqual(
    out.map((d) => [d.file.path.split('/').pop(), d.kept, d.fileClass]),
    [
      ['invoice.dto.ts', false, 'logic'],
      ['invoice.module.ts', false, 'logic'],
      ['index.ts', false, 'logic'],
      ['invoice.service.spec.ts', false, 'logic'],
      ['invoice.e2e-spec.ts', false, 'logic'],
      ['invoice.service.ts', true, 'logic'],
      ['Price.tsx', true, 'component'],
      ['README.md', false, 'logic'],
    ],
  );
  assert.match(out[0]!.reason, /skip pattern/);
});
