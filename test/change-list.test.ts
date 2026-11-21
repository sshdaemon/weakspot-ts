import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ChangeListError, parseChangeList } from '../src/change/change-list.ts';

const list = (files: unknown[], over: Record<string, unknown> = {}) => ({ repo: '/r', base: 'origin/main', head: 'working-tree', files, ...over });

test('parseChangeList reads the shared format: pairs become ranges, renamed files are modified under their new path', () => {
  const out = parseChangeList(
    list([
      { path: 'src/a.ts', status: 'modified', ranges: [[1, 1], [12, 40], [88, 88]] },
      { path: 'src/b.ts', status: 'added', ranges: 'whole' },
      { path: 'src/c.ts', status: 'renamed', oldPath: 'src/old-c.ts', ranges: [[3, 4]] },
    ]),
    'c.json',
  );
  assert.deepEqual(out, {
    repo: '/r',
    base: 'origin/main',
    head: 'working-tree',
    files: [
      { path: 'src/a.ts', status: 'modified', ranges: [{ start: 1, end: 1 }, { start: 12, end: 40 }, { start: 88, end: 88 }] },
      { path: 'src/b.ts', status: 'added', ranges: 'whole' },
      { path: 'src/c.ts', status: 'modified', ranges: [{ start: 3, end: 4 }] },
    ],
  });
});

test('parseChangeList refuses what it cannot trust, naming the place', () => {
  const bad: [unknown, RegExp][] = [
    [[], /expected a JSON object/],
    [null, /expected a JSON object/],
    ['x', /expected a JSON object/],
    [list([], { repo: '   ' }), /repo must be a non-empty string/],
    [list([{ path: 5, status: 'modified', ranges: 'whole' }]), /files\[0\]\.path must be a repo-relative path/],
    [list([{ path: 'a.ts', status: 'modified', ranges: [], removedLines: 'yes' }]), /files\[0\]\.removedLines must be true or false/],
    [list([], { repo: 'relative' }), /repo must be an absolute path/],
    [list([], { head: '' }), /head must be a non-empty string/],
    [list([], { base: 3 }), /base must be a non-empty string/],
    [{ ...list([]), files: 'x' }, /files must be an array/],
    [list([null]), /files\[0\] must be an object/],
    [list([{ path: '/abs.ts', status: 'modified', ranges: 'whole' }]), /files\[0\]\.path must be a repo-relative path/],
    [list([{ path: 'a/../../b.ts', status: 'modified', ranges: 'whole' }]), /files\[0\]\.path/],
    [list([{ path: 'a\\b.ts', status: 'modified', ranges: 'whole' }]), /files\[0\]\.path/],
    [list([{ path: 'a.ts', status: 'deleted', ranges: 'whole' }]), /files\[0\]\.status must be added, modified or renamed/],
    [list([{ path: 'a.ts', status: 'modified', ranges: 'all' }]), /files\[0\]\.ranges must be "whole" or an array/],
    [list([{ path: 'a.ts', status: 'modified', ranges: [[5, 2]] }]), /files\[0\]\.ranges\[0\] must be \[start, end\]/],
    [list([{ path: 'a.ts', status: 'modified', ranges: [[0, 2]] }]), /ranges\[0\]/],
    [list([{ path: 'a.ts', status: 'modified', ranges: [[1.5, 2]] }]), /ranges\[0\]/],
    [list([{ path: 'a.ts', status: 'modified', ranges: [[1, 2, 3]] }]), /ranges\[0\]/],
  ];
  for (const [raw, message] of bad) assert.throws(() => parseChangeList(raw, 'c.json'), (err: unknown) => err instanceof ChangeListError && message.test(err.message) && err.message.startsWith('c.json: '), JSON.stringify(raw));
});

test('parseChangeList: removedLines says what is known about removals; a file that only lost lines stays, a pure move is dropped', () => {
  const out = parseChangeList(
    list([
      { path: 'a.test.ts', status: 'modified', ranges: [], removedLines: true },
      { path: 'b.ts', status: 'modified', ranges: [[2, 3]], removedLines: false },
      { path: 'c.ts', status: 'modified', ranges: [[2, 3]] },
      { path: 'moved.ts', status: 'renamed', oldPath: 'old.ts', ranges: [], removedLines: false },
      { path: 'moved-old-format.ts', status: 'renamed', oldPath: 'old2.ts', ranges: [] },
      { path: 'moved-and-cut.ts', status: 'renamed', oldPath: 'old3.ts', ranges: [], removedLines: true },
      { path: 'new.ts', status: 'added', ranges: 'whole', removedLines: false },
    ]),
    'c.json',
  );
  assert.deepEqual(out.files, [
    { path: 'a.test.ts', status: 'modified', ranges: [], removedUnquoted: true },
    { path: 'b.ts', status: 'modified', ranges: [{ start: 2, end: 3 }], removed: [] },
    { path: 'c.ts', status: 'modified', ranges: [{ start: 2, end: 3 }] },
    { path: 'moved-and-cut.ts', status: 'modified', ranges: [], removedUnquoted: true },
    { path: 'new.ts', status: 'added', ranges: 'whole', removed: [] },
  ]);
});
