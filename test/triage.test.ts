import assert from 'node:assert/strict';
import { test } from 'vitest';
import { triage } from '../src/change/triage.ts';

const file = (path: string) => ({ path, status: 'modified' as const, ranges: 'whole' as const });

test('triage drops dtos, modules, barrels, specs and non-TypeScript, keeps services and components', () => {
  const out = triage([
    file('apps/api/src/booking/booking.dto.ts'),
    file('apps/api/src/booking/booking.module.ts'),
    file('apps/api/src/booking/index.ts'),
    file('apps/api/src/booking/booking.service.spec.ts'),
    file('apps/api/test/suites/booking.e2e-spec.ts'),
    file('apps/api/test/providers/stripe.provider.ts'),
    file('apps/api/src/booking/booking.service.ts'),
    file('src/components/Price.tsx'),
    file('README.md'),
  ]);
  assert.deepEqual(
    out.map((d) => [d.file.path.split('/').pop(), d.kept, d.fileClass]),
    [
      ['booking.dto.ts', false, 'logic'],
      ['booking.module.ts', false, 'logic'],
      ['index.ts', false, 'logic'],
      ['booking.service.spec.ts', false, 'logic'],
      ['booking.e2e-spec.ts', false, 'logic'],
      ['stripe.provider.ts', false, 'logic'],
      ['booking.service.ts', true, 'logic'],
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
