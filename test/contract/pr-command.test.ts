import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { FsPackageLocator } from '../../src/adapters/fs/package-locator.ts';
import { NodeModulesLinker } from '../../src/adapters/fs/node-modules-linker.ts';
import { GitChangeSource } from '../../src/adapters/git/git-change-source.ts';
import { GitPullRequestCheckout } from '../../src/adapters/git/pr-checkout.ts';
import { StrykerEngine } from '../../src/adapters/stryker/stryker-engine.ts';
import { ImportSpecFinder } from '../../src/adapters/ts/import-spec-finder.ts';
import { VitestRunner } from '../../src/adapters/vitest/vitest-runner.ts';
import { DEFAULTS } from '../../src/cli/config.ts';
import { prCommand } from '../../src/cli/pr-command.ts';
import { setUp } from './pr-fixture.ts';

test('pr: the pipeline runs on the pull request\'s lines in its worktree, and the worktree is gone after', { timeout: 180_000 }, async () => {
  const { root, main, pr } = setUp();
  const out = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'weakspot-pr-out-')));
  try {
    const imports = new ImportSpecFinder(1);
    const checkout = new GitPullRequestCheckout();
    const { report, worktree } = await prCommand({
      mainRoot: main,
      baseDir: main,
      ref: '7',
      keep: false,
      worktrees: path.join(root, 'trees'),
      specs: [],
      prs: { describe: () => pr },
      checkout,
      linker: new NodeModulesLinker(),
      source: new GitChangeSource(),
      out,
      config: DEFAULTS,
      runner: new VitestRunner(),
      engine: new StrykerEngine(),
      specFinder: imports,
      imports,
      packages: new FsPackageLocator(),
      log: () => {},
      commandLine: 'weakspot pr 7',
      version: 'test',
    });
    assert.equal(report.change.kind, 'pr');
    assert.deepEqual(report.packages.map((p) => p.targets), [['src/price.ts']]);
    assert.ok(report.mutants.length > 0 && report.mutants.every((m) => m.start.line === 4), 'only the changed line is mutated');
    assert.ok(report.mutants.some((m) => m.status === 'Killed'));
    assert.equal(existsSync(worktree), false);
    assert.deepEqual(checkout.list(main, path.join(root, 'trees')), []);
    assert.equal(readFileSync(path.join(main, 'src/price.ts'), 'utf8').includes('Math.round(0 + '), false, 'the checkout itself is untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});
