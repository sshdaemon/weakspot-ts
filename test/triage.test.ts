import assert from 'node:assert/strict';
import { test } from 'vitest';
import { triage } from '../src/change/triage.ts';

const file = (path: string) => ({ path, status: 'modified' as const, ranges: 'whole' as const });

test('triage drops dtos, modules, barrels, specs and non-TypeScript, keeps services and components', () => {
  const out = triage([
    file('services/api/src/invoice/invoice.dto.ts'),
    file('services/api/src/invoice/invoice.module.ts'),
    file('services/api/src/invoice/index.ts'),
    file('services/api/src/invoice/invoice.service.spec.ts'),
    file('services/api/test/e2e/invoice.e2e-spec.ts'),
    file('services/api/test/stubs/mailer.stub.ts'),
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
      ['mailer.stub.ts', false, 'logic'],
      ['invoice.service.ts', true, 'logic'],
      ['Price.tsx', true, 'component'],
      ['README.md', false, 'logic'],
    ],
  );
  assert.match(out[0]!.reason, /skip pattern/);
  assert.equal(out[3]!.reason, 'spec file');
});

test('triage drops specs by the configured patterns, so a custom spec name is not reported untested', () => {
  const patterns = { specPattern: '\\.unit\\.ts$', e2ePattern: '\\.e2e\\.ts$' };
  const out = triage([file('src/foo.unit.ts'), file('src/foo.spec.ts'), file('src/foo.ts')], [], patterns);
  assert.deepEqual(out.map((d) => [d.file.path, d.kept, d.reason]), [
    ['src/foo.unit.ts', false, 'spec file'],
    ['src/foo.spec.ts', true, ''],
    ['src/foo.ts', true, ''],
  ]);
});
