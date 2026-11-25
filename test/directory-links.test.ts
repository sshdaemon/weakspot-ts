import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { directoryLinks, linkPatterns } from '../src/adapters/stryker/directory-links.ts';

function repoWith(files: Record<string, string>, links: Record<string, string>): string {
  const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'weakspot-links-')));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, p)), { recursive: true });
    writeFileSync(path.join(repo, p), text);
  }
  for (const [p, target] of Object.entries(links)) {
    mkdirSync(path.dirname(path.join(repo, p)), { recursive: true });
    symlinkSync(target, path.join(repo, p));
  }
  execFileSync('git', ['add', '.gitignore', 'tracked'], { cwd: repo });
  return repo;
}

test('directoryLinks finds links to directories, split by whether git ignores them, and nothing else', () => {
  const repo = repoWith(
    {
      '.gitignore': '.tools/skills/\n.gen/\n.env\n/src/\\[id\\]/cache/\nnode_modules/\nlinks/\n.cache/\n.next/\ndist/\nlocked/\n',
      'tracked/.tools-settings.json': '{}\n',
      '.tools/settings.json': '{}\n',
      '.gen/client.ts': 'export {};\n',
      '.env': 'X=1\n',
      'src/a.ts': 'export {};\n',
      'node_modules/pkg/index.js': '\n',
      'fresh/notes.md': 'x\n',
    },
    {
      '.tools/skills/one': '../../src',
      'src/[id]/cache/two': '../..',
      'node_modules/.bin/three': '../pkg',
      'links/file': '../.env',
      'links/dangling': './missing',
      'links/dir': '../src',
      '.gen/node_modules/four': '../..',
      'tracked/link': '../src',
      'fresh/.cache/five': '../..',
      'loose/dir': '../src',
      'loose/file': '../.env',
      '.next/six': '..',
      'dist/seven': '..',
    },
  );
  try {
    execFileSync('git', ['add', '.tools/settings.json'], { cwd: repo });
    mkdirSync(path.join(repo, 'locked/inner'), { recursive: true });
    chmodSync(path.join(repo, 'locked/inner'), 0o000);
    const links = directoryLinks(repo);
    chmodSync(path.join(repo, 'locked/inner'), 0o755);
    assert.deepEqual(links.ignored.toSorted(), ['.tools/skills/one', 'fresh/.cache/five', 'links/dir', 'src/[id]/cache/two']);
    assert.deepEqual(links.other.toSorted(), ['loose/dir', 'tracked/link']);
    assert.deepEqual(directoryLinks(path.join(repo, 'src')), { ignored: ['[id]/cache/two'], other: [] });
    assert.deepEqual(directoryLinks(path.join(repo, 'fresh')), { ignored: ['.cache/five'], other: [] });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('directoryLinks walks a folder git lists as a whole, as it does when nothing is tracked yet', () => {
  const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'weakspot-untracked-')));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(path.join(repo, '.gitignore'), '.cache/\n');
    mkdirSync(path.join(repo, 'sub/.cache'), { recursive: true });
    symlinkSync('../..', path.join(repo, 'sub/.cache/x'));
    writeFileSync(path.join(repo, '.gitignore'), '.cache/\nnode_modules\n');
    symlinkSync('..', path.join(repo, 'sub/node_modules'));
    assert.deepEqual(directoryLinks(path.join(repo, 'sub')), { ignored: ['.cache/x'], other: [] });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('linkPatterns anchors and escapes every link', () => {
  assert.deepEqual(linkPatterns({ ignored: ['src/[id]/a'], other: ['b'] }), ['/src/[[]id[]]/a', '/b']);
});

test('directoryLinks is empty outside a git repo', () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'weakspot-nogit-')));
  try {
    symlinkSync('.', path.join(dir, 'self'));
    assert.deepEqual(directoryLinks(dir), { ignored: [], other: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
