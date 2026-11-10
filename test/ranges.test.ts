import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LineRange, parseFileArg } from '../src/change/ranges.ts';

test('parseFileArg reads path, path:line and path:start-end', () => {
  assert.deepEqual(parseFileArg('src/a.ts'), { path: 'src/a.ts', ranges: 'whole' });
  assert.deepEqual(parseFileArg('src/a.ts:7'), { path: 'src/a.ts', ranges: [{ start: 7, end: 7 }] });
  assert.deepEqual(parseFileArg('src/a.ts:12-40'), { path: 'src/a.ts', ranges: [{ start: 12, end: 40 }] });
});

test('LineRange.merge joins touching and overlapping ranges', () => {
  const merged = LineRange.merge([LineRange.of(10, 12), LineRange.of(1, 3), LineRange.of(4, 5), LineRange.of(11, 20)]);
  assert.deepEqual(merged, [{ start: 1, end: 5 }, { start: 10, end: 20 }]);
});

test('LineRange.of rejects an inverted range', () => {
  assert.throws(() => LineRange.of(5, 2));
});
