import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { FsPackageLocator } from '../../src/adapters/fs/package-locator.ts';
import { GitChangeSource } from '../../src/adapters/git/git-change-source.ts';
import { StrykerEngine } from '../../src/adapters/stryker/stryker-engine.ts';
import { ImportSpecFinder } from '../../src/adapters/ts/import-spec-finder.ts';
import { VitestRunner } from '../../src/adapters/vitest/vitest-runner.ts';
import { DEFAULTS } from '../../src/cli/config.ts';
import { diffCommand } from '../../src/cli/diff-command.ts';
import { parseChangeList } from '../../src/change/change-list.ts';

const fixtures = path.resolve(import.meta.dirname, '../../fixtures');
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env });

test('diff command: mutates only the changed lines, mutates a source whole when its spec changed, reports an untested new file', { timeout: 180_000 }, async () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'weakspot-diff-'));
  const out = mkdtempSync(path.join(os.tmpdir(), 'weakspot-diff-out-'));
  try {
    cpSync(path.join(fixtures, 'vitest-basic'), repo, { recursive: true, filter: (src) => !src.endsWith('node_modules') });
    symlinkSync(path.resolve(fixtures, '..', 'node_modules'), path.join(repo, 'node_modules'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'checkout', '-q', '-b', 'feature');
    // 1. change one line of price.ts (the rounding), 2. touch format.test.ts only, 3. add an untested file
    const price = readFileSync(path.join(repo, 'src/price.ts'), 'utf8').replace('Math.round(', 'Math.round(0 + ');
    writeFileSync(path.join(repo, 'src/price.ts'), price);
    writeFileSync(path.join(repo, 'src/format.test.ts'), `${readFileSync(path.join(repo, 'src/format.test.ts'), 'utf8')}\n// touched\n`);
    writeFileSync(path.join(repo, 'src/orphan.ts'), 'export const orphan = (n: number) => (n > 3 ? 1 : 0);\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'change');

    const imports = new ImportSpecFinder(1);
    const { report } = await diffCommand({
      source: new GitChangeSource(),
      base: 'main',
      scope: 'working',
      specs: [],
      baseDir: repo,
      repoRoot: repo,
      out,
      config: DEFAULTS,
      runner: new VitestRunner(),
      engine: new StrykerEngine(),
      specFinder: imports,
      imports,
      packages: new FsPackageLocator(),
      log: () => {},
      commandLine: 'contract test',
      version: 'test',
    });
    assert.equal(report.change.kind, 'diff');
    assert.deepEqual(report.untested, ['src/orphan.ts']);
    assert.deepEqual(report.viaChangedSpec, ['src/format.ts']);
    assert.ok(report.findings.some((f) => f.kind === 'untested' && f.where === 'src/orphan.ts'), 'untested file is a finding');
    const pkg = report.packages[0]!;
    assert.deepEqual(pkg.targets.toSorted(), ['src/format.ts', 'src/price.ts']);
    assert.ok(pkg.specs.includes('src/format.test.ts') && pkg.specs.includes('src/price.test.ts'), JSON.stringify(pkg.specs));
    // price.ts: only line 4 changed, so every price.ts mutant sits on line 4
    const priceMutants = report.mutants.filter((m) => m.file === 'src/price.ts');
    assert.ok(priceMutants.length > 0 && priceMutants.every((m) => m.start.line === 4), JSON.stringify(priceMutants.map((m) => m.start.line)));
    // format.ts: mutated whole because format.test.ts changed
    assert.ok(report.mutants.some((m) => m.file === 'src/format.ts'));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('diff command with a change list: mutates exactly the listed lines, and a spec in the list always counts as changed', { timeout: 180_000 }, async () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'weakspot-changes-'));
  const out = mkdtempSync(path.join(os.tmpdir(), 'weakspot-changes-out-'));
  try {
    cpSync(path.join(fixtures, 'vitest-basic'), repo, { recursive: true, filter: (src) => !src.endsWith('node_modules') });
    symlinkSync(path.resolve(fixtures, '..', 'node_modules'), path.join(repo, 'node_modules'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    const list = parseChangeList(
      {
        repo,
        base: 'main',
        head: 'working-tree',
        files: [
          { path: 'src/price.ts', status: 'modified', ranges: [[2, 2]] },
          { path: 'src/format.test.ts', status: 'modified', ranges: [[1, 1]] },
        ],
      },
      'changes.json',
    );
    const imports = new ImportSpecFinder(1);
    const { report } = await diffCommand({
      source: new GitChangeSource(),
      base: 'unused',
      scope: 'working',
      changeList: { list, file: 'changes.json' },
      specs: [],
      baseDir: repo,
      repoRoot: repo,
      out,
      config: DEFAULTS,
      runner: new VitestRunner(),
      engine: new StrykerEngine(),
      specFinder: imports,
      imports,
      packages: new FsPackageLocator(),
      log: () => {},
      commandLine: 'contract test',
      version: 'test',
    });
    assert.equal(report.change.kind, 'changes');
    assert.match(report.change.detail, /^main\.\.working-tree, from changes\.json$/);
    assert.ok(report.mutants.filter((m) => m.file === 'src/price.ts').every((m) => m.start.line === 2), 'only line 2 of price.ts');
    assert.ok(report.mutants.some((m) => m.file === 'src/price.ts'));
    assert.deepEqual(report.viaChangedSpec, ['src/format.ts'], 'the list has no removed text, so its import-line spec edit still counts');
    assert.deepEqual(report.importOnlySpecs, []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});
