import assert from 'node:assert/strict';
import { test } from 'node:test';
import { triage } from '../src/change/triage.ts';

const file = (path: string) => ({ path, status: 'modified' as const, ranges: 'whole' as const });

test('triage drops dtos, modules, barrels, specs and non-TypeScript, keeps services and components', () => {
  const out = triage([
    file('apps/api/src/booking/booking.dto.ts'),
    file('apps/api/src/booking/booking.module.ts'),
    file('apps/api/src/booking/index.ts'),
    file('apps/api/src/booking/booking.service.spec.ts'),
    file('apps/api/test/suites/booking.e2e-spec.ts'),
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
      ['booking.service.ts', true, 'logic'],
      ['Price.tsx', true, 'component'],
      ['README.md', false, 'logic'],
    ],
  );
  assert.match(out[0]!.reason, /skip pattern/);
});
