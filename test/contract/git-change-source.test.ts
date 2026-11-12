import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { GitChangeSource } from '../../src/adapters/git/git-change-source.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
}

test('git change source: committed, staged and working scopes against a base branch', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'weakspot-git-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(dir, 'a.ts'), 'l1\nl2\nl3\nl4\n');
    execFileSync('mkdir', ['-p', path.join(dir, 'src/i')]);
    writeFileSync(path.join(dir, 'src/i/x.ts'), 'other\n'); // outside the change; edited later to probe the dirty check
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base');
    git(dir, 'checkout', '-q', '-b', 'feature');
    execFileSync('mkdir', ['-p', path.join(dir, 'sub')]);
    writeFileSync(path.join(dir, 'a.ts'), 'l1\nL2\nl3\nl4\nl5\n'); // modify line 2, add line 5
    git(dir, 'commit', '-q', '-am', 'change');
    const src = new GitChangeSource();
    const committed = src.changes({ repoRoot: dir, base: 'main', scope: 'committed' });
    assert.deepEqual(committed, [{ path: 'a.ts', status: 'modified', ranges: [{ start: 2, end: 2 }, { start: 5, end: 5 }] }]);
    writeFileSync(path.join(dir, 'b.ts'), 'new\n');
    git(dir, 'add', 'b.ts'); // staged new file
    writeFileSync(path.join(dir, 'a.ts'), 'l1\nL2\nl3\nl4\nl5\nl6\n'); // unstaged add line 6
    writeFileSync(path.join(dir, 'c.ts'), 'untracked\n');
    // a bracket folder in the change: the dirty check must take it literally, not as the glob src/i/x.ts matches
    execFileSync('mkdir', ['-p', path.join(dir, 'src/[id]')]);
    writeFileSync(path.join(dir, 'src/[id]/x.ts'), 'bracket\n');
    git(dir, 'add', 'src');
    git(dir, 'commit', '-q', '-m', 'bracket');
    writeFileSync(path.join(dir, 'src/i/x.ts'), 'other edited\n');
    writeFileSync(path.join(dir, 'café d.ts'), 'non ascii, with a space\n');
    git(dir, 'add', 'café d.ts');

    // a.ts has unstaged edits, so staged and committed ranges would not describe the working tree
    assert.throws(() => src.changes({ repoRoot: dir, base: 'main', scope: 'staged' }), /unstaged edits: a\.ts/);
    assert.throws(() => src.changes({ repoRoot: dir, base: 'main', scope: 'committed' }), /uncommitted edits: a\.ts/);
    git(dir, 'add', 'a.ts');
    const staged = src.changes({ repoRoot: dir, base: 'main', scope: 'staged' });
    assert.deepEqual(staged.map((f) => f.path), ['a.ts', 'b.ts', 'café d.ts', 'src/[id]/x.ts']);
    assert.throws(() => src.changes({ repoRoot: dir, base: 'main', scope: 'committed' }), /uncommitted edits: a\.ts$/, 'src/i/x.ts is dirty but not in the change, and [id] is literal');
    assert.deepEqual(staged[1], { path: 'b.ts', status: 'added', ranges: [{ start: 1, end: 1 }] });

    const working = src.changes({ repoRoot: dir, base: 'main', scope: 'working' });
    assert.deepEqual(working.map((f) => [f.path, f.ranges]), [
      ['a.ts', [{ start: 2, end: 2 }, { start: 5, end: 6 }]],
      ['b.ts', [{ start: 1, end: 1 }]],
      ['café d.ts', [{ start: 1, end: 1 }]],
      ['src/[id]/x.ts', [{ start: 1, end: 1 }]],
      ['src/i/x.ts', [{ start: 1, end: 1 }]],
      ['c.ts', 'whole'],
    ]);
    assert.equal(src.defaultBase(dir), undefined, 'no origin, no default base');
    assert.throws(() => src.changes({ repoRoot: path.join(dir, 'sub'), base: 'main', scope: 'working' }), /not the top of its git checkout|ENOENT|no such/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git change source: a moved file with one edit yields only the edited line, under its new path', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'weakspot-git-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(dir, 'big.ts'), `${Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i};`).join('\n')}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base');
    git(dir, 'checkout', '-q', '-b', 'feature');
    git(dir, 'mv', 'big.ts', 'moved.ts');
    const text = readFileSync(path.join(dir, 'moved.ts'), 'utf8').replace('export const v20 = 20;', 'export const v20 = 21;');
    writeFileSync(path.join(dir, 'moved.ts'), text);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'move');
    const out = new GitChangeSource().changes({ repoRoot: dir, base: 'main', scope: 'committed' });
    assert.deepEqual(out, [{ path: 'moved.ts', status: 'modified', ranges: [{ start: 21, end: 21 }] }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git change source: inter-hunk context config and GIT_DIFF_OPTS do not widen the ranges', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'weakspot-git-'));
  const previous = process.env['GIT_DIFF_OPTS'];
  try {
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(dir, 'a.ts'), 'l1\nl2\nl3\nl4\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base');
    git(dir, 'checkout', '-q', '-b', 'feature');
    git(dir, 'config', 'diff.interHunkContext', '3');
    process.env['GIT_DIFF_OPTS'] = '-u2';
    writeFileSync(path.join(dir, 'a.ts'), 'L1\nl2\nl3\nL4\n');
    git(dir, 'commit', '-q', '-am', 'two edits');
    const out = new GitChangeSource().changes({ repoRoot: dir, base: 'main', scope: 'committed' });
    assert.deepEqual(out, [{ path: 'a.ts', status: 'modified', ranges: [{ start: 1, end: 1 }, { start: 4, end: 4 }] }]);
  } finally {
    if (previous === undefined) delete process.env['GIT_DIFF_OPTS'];
    else process.env['GIT_DIFF_OPTS'] = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
