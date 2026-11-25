import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { Placeholder } from '../src/mutation/model.ts';
import { MutantsFileError, mutantEntries, validateMutants, type Misfit } from '../src/mutation/validate.ts';

const ph = (id: string, original: string, cached?: Placeholder['cached']): Placeholder => ({
  id,
  file: 'src/a.ts',
  kind: 'condition',
  start: { line: 1, column: 5 },
  end: { line: 1, column: 5 + original.length },
  original,
  scope: 'f',
  ...(cached ? { cached } : {}),
});

const fits: Misfit = () => undefined;
const entry = (placeholder: string, replacement: string, because = 'it differs') => ({ placeholder, replacement, because });

test('mutantEntries: only a { mutants: [...] } container is a mutants file', () => {
  assert.deepEqual(mutantEntries({ mutants: [1] }, 'f.json'), [1]);
  for (const raw of [null, [], { mutants: {} }, { other: [] }]) assert.throws(() => mutantEntries(raw, 'f.json'), (e: unknown) => e instanceof MutantsFileError && /f\.json: expected \{ "mutants"/.test(e.message));
});

const misfitOnBad: Misfit = (_p, r) => (r === 'bad(' ? 'does not parse: x' : undefined);

test('each rule rejects with a reason the author can act on, and the rest run, trimmed', () => {
  const placeholders = [ph('a', 'x > 1'), ph('b', 'y')];
  const { valid, rejected } = validateMutants(
    [
      entry('a', '  x >= 1 ', ' boundary moves  '),
      entry('a', 'x  >=  1'),
      entry('a', 'x > 1'),
      entry('a', 'x < 1'),
      entry('a', 'x !== 1'),
      entry('a', 'true'),
      entry('b', 'bad('),
      entry('zz', 'q'),
      entry('b', 'z', ' '),
      { placeholder: 'b', replacement: 7, because: 'x' },
      'not an object',
    ],
    placeholders,
    misfitOnBad,
  );
  assert.deepEqual(valid.map((v) => [v.placeholder, v.replacement, v.because, v.cached]), [
    ['a', 'x >= 1', 'boundary moves', false],
    ['a', 'x < 1', 'it differs', false],
    ['a', 'x !== 1', 'it differs', false],
  ]);
  assert.equal(valid[0]!.target, placeholders[0]);
  assert.deepEqual(rejected.map((r) => [r.placeholder, r.replacement, r.reason]), [
    ['a', 'x  >=  1', 'duplicate of an earlier answer for this placeholder'],
    ['a', 'x > 1', 'identical to the original'],
    ['a', 'true', 'more than 3 answers for this placeholder'],
    ['b', 'bad(', 'does not parse: x'],
    ['zz', 'q', 'no such placeholder in the placeholders file'],
    ['b', 'z', 'because is empty: say in one line how the behaviour differs'],
    ['b', '', 'replacement missing or not a string'],
    ['', '', 'not an object'],
  ]);
});

test('cached mutants run for placeholders the author left unanswered, and are judged like any answer', () => {
  const placeholders = [ph('a', 'x', [{ replacement: 'y', because: 'old a' }]), ph('b', 'u', [{ replacement: 'v', because: 'old b' }, { replacement: 'u', because: 'now identical' }]), ph('c', 'k')];
  const { valid, rejected } = validateMutants([entry('a', 'z'), entry('c', 'zz')], placeholders, fits);
  assert.deepEqual(valid.map((v) => [v.placeholder, v.replacement, v.cached]), [
    ['a', 'z', false],
    ['c', 'zz', false],
    ['b', 'v', true],
  ]);
  assert.deepEqual(rejected, [{ placeholder: 'b', replacement: 'u', reason: 'identical to the original' }]);
  const allRejected = validateMutants([entry('a', 'x')], placeholders, fits);
  assert.ok(!allRejected.valid.some((v) => v.placeholder === 'a'), 'an answered placeholder drops its cached mutants even when every answer is rejected');
});

test('misfit sees the placeholder and the trimmed replacement', () => {
  const seen: string[] = [];
  validateMutants([entry('a', '  q  ')], [ph('a', 'x')], (p, r) => {
    seen.push(`${p.id}:${r}`);
    return undefined;
  });
  assert.deepEqual(seen, ['a:q']);
});
