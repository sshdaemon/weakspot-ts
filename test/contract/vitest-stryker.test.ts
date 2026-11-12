import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
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
