import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { FsPackageLocator } from '../../src/adapters/fs/package-locator.ts';
import { ImportSpecFinder } from '../../src/adapters/ts/import-spec-finder.ts';
import { StrykerEngine, TestsFailBeforeMutationError } from '../../src/adapters/stryker/stryker-engine.ts';
import { VitestRunner } from '../../src/adapters/vitest/vitest-runner.ts';
import { DEFAULTS } from '../../src/cli/config.ts';
import { UsageError, filesCommand } from '../../src/cli/files-command.ts';

const fixtures = path.resolve(import.meta.dirname, '../../fixtures');

/** Every path under `dir`, not following the node_modules symlink. */
function listTree(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    out.push(p);
    if (e.isDirectory() && !e.isSymbolicLink()) listTree(p, out);
  }
  return out;
}

async function runFixture(name: string, files: string[], specs: string[] = [], outOverride?: string) {
  const repoRoot = path.join(fixtures, name);
  const out = outOverride ?? mkdtempSync(path.join(os.tmpdir(), 'weakspot-contract-'));
  try {
    const { report } = await filesCommand({
      files,
      specs,
      repoRoot,
      baseDir: repoRoot,
      out,
      config: DEFAULTS,
      runner: new VitestRunner(),
      engine: new StrykerEngine(),
      specFinder: new ImportSpecFinder(),
      imports: new ImportSpecFinder(),
      packages: new FsPackageLocator(),
      log: () => {},
      commandLine: 'contract test',
      version: 'test',
    });
    return { report, md: readFileSync(path.join(out, 'report.md'), 'utf8'), hasJson: existsSync(path.join(out, 'report.json')) };
  } finally {
    if (!outOverride) rmSync(out, { recursive: true, force: true });
  }
}

test('vitest + stryker: the fixture yields killed mutants, a weak assertion and an uncovered branch', { timeout: 180_000 }, async () => {
  const { report, md, hasJson } = await runFixture('vitest-basic', ['src/price.ts']);
  const pkg = report.packages[0]!;
  assert.equal(report.packages.length, 1);
  assert.equal(pkg.specs[0], 'src/price.test.ts');
  assert.ok(pkg.testCount >= 4, `dry run saw ${pkg.testCount} tests`);
  assert.ok((pkg.counts['Killed'] ?? 0) >= 5, `killed: ${JSON.stringify(pkg.counts)}`);
  assert.ok((pkg.counts['NoCoverage'] ?? 0) >= 1, `no coverage: ${JSON.stringify(pkg.counts)}`);
  assert.ok(report.survivors.some((s) => s.kind === 'weakAssertion' && s.mutant.start.line === 9), 'the label() condition survives');
  assert.ok(report.mutants.some((m) => m.start.line === 9 && m.original === 'pence % 100 === 0'), 'mutants carry the source text they replace');
  assert.deepEqual(report.warnings, []);
  assert.ok(hasJson);
  assert.match(md, /## Survivors \(\d+\)/);
});

test('vitest + stryker: a function config with an absolute alias into the project still kills mutants', { timeout: 180_000 }, async () => {
  const { report } = await runFixture('vitest-alias', ['src/price.ts']);
  const counts = report.packages[0]!.counts;
  assert.ok((counts['Killed'] ?? 0) >= 5, `killed: ${JSON.stringify(counts)}`);
  assert.ok(report.survivors.some((s) => s.kind === 'weakAssertion'), 'coverage was recorded through the alias');
});

test('vitest + stryker: a source under a [id] folder is matched and mutated', { timeout: 180_000 }, async () => {
  const { report } = await runFixture('vitest-bracket', ['src/[id]/price.ts']);
  const counts = report.packages[0]!.counts;
  assert.deepEqual(report.warnings, []);
  assert.ok((counts['Killed'] ?? 0) >= 5, `killed: ${JSON.stringify(counts)}`);
});

test('vitest + stryker: a file of module-level code yields static survivors, not a "never loaded" error', { timeout: 180_000 }, async () => {
  const { report } = await runFixture('vitest-basic', ['src/limits.ts']);
  assert.deepEqual(report.warnings, []);
  assert.ok(report.survivors.length > 0 && report.survivors.every((s) => s.kind === 'static'), JSON.stringify(report.survivors.map((s) => s.kind)));
  assert.match(report.findings[0]!.claim, /runs at module load/);
});

test('vitest + stryker: a red dry run fails with the failing test named', { timeout: 180_000 }, async () => {
  await assert.rejects(runFixture('vitest-red', ['src/price.ts']), (err: unknown) => {
    assert.ok(err instanceof TestsFailBeforeMutationError, String(err));
    assert.match(err.message, /rounds to the nearest penny/);
    assert.match(err.message, /expected 669 to be 670/);
    return true;
  });
});

test('a run leaves the fixture tree and the shared node_modules caches untouched', { timeout: 180_000 }, async () => {
  const fixture = path.join(fixtures, 'vitest-basic');
  const nodeModules = path.resolve(fixtures, '..', 'node_modules');
  const snapshot = () => {
    const files = listTree(fixture).map((f) => `${f}:${statSync(f).mtimeMs}`);
    // Every dot-prefixed dir under the shared node_modules, walked recursively: a directory's own
    // mtime does not move when a file two levels down is rewritten, and a new cache dir must fail too.
    const caches = readdirSync(nodeModules, { withFileTypes: true })
      .filter((e) => e.name.startsWith('.') && e.isDirectory())
      .map((e) => path.join(nodeModules, e.name))
      .flatMap((d) => [d, ...listTree(d)].map((f) => `${f}:${statSync(f).mtimeMs}`));
    return [...files, ...caches].join('\n');
  };
  const before = snapshot();
  await runFixture('vitest-basic', ['src/price.ts']);
  assert.equal(snapshot(), before);
});

test('files command rejects a missing file, a file outside the repo and a spec outside the package', async () => {
  await assert.rejects(runFixture('vitest-basic', ['src/nope.ts']), UsageError);
  await assert.rejects(runFixture('vitest-basic', [path.join(fixtures, 'vitest-alias/src/price.ts')]), /outside the repo root/);
  // The fixtures folder is the repo here, vitest-basic the package: a sibling fixture's spec is inside the repo but outside the package.
  await assert.rejects(runFixture('.', ['vitest-basic/src/price.ts'], ['vitest-alias/src/price.test.ts']), /outside package vitest-basic/);
  await assert.rejects(runFixture('vitest-basic', ['src/price.ts'], [], path.join(fixtures, 'vitest-basic', 'out')), /--out .* is inside the repo/);
});

test('vitest runner: a direct run of the fixture specs passes', { timeout: 60_000 }, async () => {
  const runner = new VitestRunner();
  const fixture = path.join(fixtures, 'vitest-basic');
  const pkg = { dir: fixture, name: 'fixture-vitest-basic', testConfig: path.join(fixture, 'vitest.config.ts') };
  const shimDir = mkdtempSync(path.join(os.tmpdir(), 'weakspot-shim-'));
  try {
    const shim = runner.writeShim(pkg, { root: fixture, include: ['src/price.test.ts'] }, path.join(shimDir, 'vitest.shim.mts'));
    const result = await runner.run(pkg, shim, fixture, 60_000);
    assert.equal(result.failed, 0, result.output);
    assert.equal(result.passed, 4);
  } finally {
    rmSync(shimDir, { recursive: true, force: true });
  }
});

test('vitest + stryker: links to directories stay out of the sandbox; a tracked one is reported', { timeout: 180_000 }, async () => {
  const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'weakspot-links-')));
  const out = mkdtempSync(path.join(os.tmpdir(), 'weakspot-links-out-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo, stdio: 'ignore' });
  try {
    cpSync(path.join(fixtures, 'vitest-basic'), repo, { recursive: true, filter: (src) => !src.endsWith('node_modules') });
    symlinkSync(path.resolve(fixtures, '..', 'node_modules'), path.join(repo, 'node_modules'));
    mkdirSync(path.join(repo, '.tools/skills'), { recursive: true });
    writeFileSync(path.join(repo, '.tools/settings.json'), '{}\n');
    symlinkSync('../../src', path.join(repo, '.tools/skills/src'));
    symlinkSync('src', path.join(repo, 'src-link'));
    writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n.tools/skills/\n');
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    const logs: string[] = [];
    const files = (specs: string[]) => filesCommand({
      files: ['src/price.ts'],
      specs,
      repoRoot: repo,
      baseDir: repo,
      out,
      config: DEFAULTS,
      runner: new VitestRunner(),
      engine: new StrykerEngine(),
      specFinder: new ImportSpecFinder(),
      imports: new ImportSpecFinder(),
      packages: new FsPackageLocator(),
      log: (line) => logs.push(line),
      commandLine: 'contract test',
      version: 'test',
    });
    const { report } = await files([]);
    assert.ok((report.packages[0]!.counts['Killed'] ?? 0) >= 5, `killed: ${JSON.stringify(report.packages[0]!.counts)}`);
    assert.deepEqual(report.warnings, ['src-link: link to a directory, left out of the mutation sandbox']);
    assert.ok(logs.some((l) => l.endsWith('src-link: link to a directory, left out of the mutation sandbox')), 'logged before Stryker runs');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

