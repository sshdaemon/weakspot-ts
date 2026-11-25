import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { NodeModulesLinker } from '../../src/adapters/fs/node-modules-linker.ts';
import { GitPullRequestCheckout } from '../../src/adapters/git/pr-checkout.ts';
import { git, setUp } from './pr-fixture.ts';

test('git checkout for a pull request: fetch, changed paths, a reusable detached worktree, listing and removal', () => {
  const { root, main, pr } = setUp();
  try {
    const checkout = new GitPullRequestCheckout();
    assert.equal(checkout.originRepo(main), 'org/app');
    checkout.checkTop(main);
    assert.throws(() => checkout.checkTop(path.join(main, 'src')), /is not the top of its git checkout/);
    checkout.fetch(main, pr);
    assert.deepEqual(checkout.lockfileDrift(main, pr.headSha), [], 'the installed lockfile matches the head');
    writeFileSync(path.join(main, 'package-lock.json'), '{ "lockfileVersion": 2 }\n');
    assert.deepEqual(checkout.lockfileDrift(main, pr.headSha), ['package-lock.json'], 'an older install');
    rmSync(path.join(main, 'package-lock.json'));
    assert.deepEqual(checkout.lockfileDrift(main, pr.headSha), ['package-lock.json'], 'no install at all');
    assert.throws(() => checkout.fetch(main, { ...pr, headSha: 'f'.repeat(40) }), /pull request 7 moved since it was read: its head ffffffffffff/);
    const trees = path.join(root, 'trees');
    const dir = path.join(trees, 'pr-7');
    assert.equal(checkout.add(main, dir, pr.headSha), false);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), pr.headSha);
    assert.equal(checkout.add(main, dir, pr.headSha), true, 'the same commit, clean: reused');
    writeFileSync(path.join(dir, 'untracked.txt'), 'notes\n');
    assert.equal(checkout.add(main, dir, pr.headSha), true, 'an untracked file does not block reuse');
    writeFileSync(path.join(dir, 'src/price.ts'), 'edited\n');
    assert.throws(() => checkout.add(main, dir, pr.headSha), /the kept worktree .* has edits: src\/price\.ts; save what you need from it, then run weakspot pr --clean/);
    assert.equal(readFileSync(path.join(dir, 'src/price.ts'), 'utf8'), 'edited\n', 'the edit is still there');
    git(dir, 'checkout', '-q', '--', 'src/price.ts');
    assert.equal(checkout.add(main, dir, pr.baseSha), false, 'another commit is made again');
    assert.equal(git(dir, 'rev-parse', 'HEAD'), pr.baseSha);
    assert.deepEqual(checkout.list(main, trees).map((d) => realpathSync(d)), [realpathSync(dir)]);
    assert.deepEqual(checkout.list(main, path.join(root, 'elsewhere')), []);
    checkout.remove(main, dir);
    assert.deepEqual([existsSync(dir), checkout.list(main, trees)], [false, []]);
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'src/stale.ts'), 'left behind\n');
    assert.equal(checkout.add(main, dir, pr.headSha), false, 'a folder left where a worktree was is replaced');
    assert.deepEqual([existsSync(path.join(dir, 'src/stale.ts')), git(dir, 'rev-parse', 'HEAD')], [false, pr.headSha]);
    checkout.remove(main, dir);
    mkdirSync(dir, { recursive: true });
    checkout.remove(main, dir);
    assert.equal(existsSync(dir), false, 'remove drops a folder that is no worktree');
    assert.equal(new GitPullRequestCheckout().originRepo(root), undefined, 'no git checkout, no origin');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('node_modules linker: a folder of links per package, scope folders made real, workspace packages pointed at the tree', () => {
  const { root, main, pr } = setUp();
  try {
    const checkout = new GitPullRequestCheckout();
    checkout.fetch(main, pr);
    const dir = path.join(root, 'trees', 'pr-7');
    checkout.add(main, dir, pr.headSha);
    assert.deepEqual(new NodeModulesLinker().link(main, dir), ['.', 'packages/shared']);
    const modules = path.join(dir, 'node_modules');
    assert.equal(lstatSync(modules).isDirectory() && !lstatSync(modules).isSymbolicLink(), true);
    assert.equal(readlinkSync(path.join(modules, 'vitest')), path.join(realpathSync(main), 'node_modules', 'vitest'));
    assert.equal(lstatSync(path.join(modules, '@app')).isSymbolicLink(), false);
    assert.equal(readlinkSync(path.join(modules, '@app/shared')), path.join(dir, 'packages/shared'));
    assert.equal(readlinkSync(path.join(modules, '@app/removed')), path.join(dir, 'packages/removed'), 'a dangling workspace link still maps into the tree');
    assert.equal(readlinkSync(path.join(modules, 'sibling-lib')), path.join(realpathSync(main), 'node_modules', 'sibling-lib'), 'a link outside the checkout stays on the install');
    assert.equal(readlinkSync(path.join(modules, '.pnpm')), path.join(realpathSync(main), 'node_modules', '.pnpm'), 'a real folder is linked as one entry');
    const shared = path.join(dir, 'packages/shared/node_modules');
    assert.equal(readlinkSync(path.join(shared, 'vitest')), path.join(realpathSync(main), 'packages/shared/node_modules', 'vitest'));
    assert.equal(readlinkSync(path.join(shared, '@app/other')), path.join(dir, 'packages/other'));
    assert.deepEqual(new NodeModulesLinker().link(main, dir), [], 'a package that has node_modules already is left alone');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
