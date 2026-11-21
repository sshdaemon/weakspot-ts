import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, test } from 'vitest';
import { ChangeListError } from '../src/change/change-list.ts';
import { checkListedFilesExist, readChangeList, repoRootOf } from '../src/cli/change-list-input.ts';
import { UsageError } from '../src/cli/pipeline.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'weakspot-list-input-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const repo = path.join(dir, 'repo');
mkdirSync(path.join(repo, 'src'), { recursive: true });
writeFileSync(path.join(repo, 'src/a.ts'), '');
const link = path.join(dir, 'link');
symlinkSync(repo, link);
const found = () => '/found';
const list = { repo, base: 'main', head: 'working-tree', files: [{ path: 'src/a.ts', status: 'modified' as const, ranges: 'whole' as const }] };

test('readChangeList: a missing file or bad JSON is a change list error naming the file', () => {
  const good = path.join(dir, 'good.json');
  writeFileSync(good, JSON.stringify(list));
  assert.equal(readChangeList(good).repo, repo);
  assert.throws(() => readChangeList(path.join(dir, 'missing.json')), (err: unknown) => err instanceof ChangeListError && /missing\.json: cannot read a JSON change list/.test(err.message));
  const bad = path.join(dir, 'bad.json');
  writeFileSync(bad, '{nope');
  assert.throws(() => readChangeList(bad), ChangeListError);
});

test('repoRootOf: --repo wins, then the list, then what the locator finds; --repo and the list must agree, symlinks resolved', () => {
  assert.equal(repoRootOf(undefined, undefined, found), '/found');
  assert.equal(repoRootOf(undefined, list, found), repo);
  assert.equal(repoRootOf(link, list, found), link, 'a symlink to the same directory agrees');
  assert.equal(repoRootOf(repo, undefined, found), repo);
  assert.throws(() => repoRootOf(path.join(dir, 'other'), list, found), (err: unknown) => err instanceof UsageError && /the change list is for .*repo, but --repo is .*other/.test(err.message));
});

test('checkListedFilesExist: a stale list is refused, naming the missing files', () => {
  assert.doesNotThrow(() => checkListedFilesExist(repo, list, 'c.json'));
  const stale = { ...list, files: [...list.files, { path: 'src/gone.ts', status: 'modified' as const, ranges: 'whole' as const }] };
  assert.throws(() => checkListedFilesExist(repo, stale, 'c.json'), (err: unknown) => err instanceof ChangeListError && /c\.json: listed files do not exist in .*: src\/gone\.ts$/.test(err.message));
});
