import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MapSpecFinder } from '../../src/adapters/fs/map-spec-finder.ts';
import { FsPackageLocator } from '../../src/adapters/fs/package-locator.ts';
import { StrykerEngine } from '../../src/adapters/stryker/stryker-engine.ts';
import { ImportSpecFinder } from '../../src/adapters/ts/import-spec-finder.ts';
import { VitestRunner } from '../../src/adapters/vitest/vitest-runner.ts';
import { validate } from '../../src/cli/config.ts';
import { filesCommand } from '../../src/cli/files-command.ts';
import type { LaneSelection } from '../../src/mutation/lanes.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/vitest-lanes');

async function run(files: string[], laneSelection: LaneSelection, out: string, prepared: string) {
  const config = validate(
    {
      lanes: {
        e2e: {
          config: 'vitest-e2e.config.ts',
          specs: { map: [['^packages/([^/]+)/src/', 'packages/$1/e2e/**/*.e2e.ts']] },
          envPerWorker: { FIXTURE_DB: 'db_{worker}' },
          prepare: `echo prepared > '${prepared}'`,
          concurrency: 2,
          timeoutMs: 10000,
        },
      },
    },
    'contract test',
  );
  const e2e = config.lanes[1]!;
  const imports = new ImportSpecFinder(1, config);
  const { report } = await filesCommand({
    files,
    specs: [],
    repoRoot,
    baseDir: repoRoot,
    out,
    config,
    runner: new VitestRunner(),
    engine: new StrykerEngine(),
    specFinder: imports,
    imports,
    lanes: [{ config: e2e, finder: new MapSpecFinder((e2e.specs[0] as { map: readonly (readonly [string, string])[] }).map) }],
    laneSelection,
    packages: new FsPackageLocator([e2e.config!]),
    log: () => {},
    commandLine: 'contract test',
    version: 'test',
  });
  return { report, md: readFileSync(path.join(out, 'report.md'), 'utf8') };
}

test('lanes: the e2e lane takes the files the unit lane left, with per-worker env, an outside global setup, a prepare step and a package that has only an e2e config', { timeout: 300_000 }, async () => {
  const out = mkdtempSync(path.join(os.tmpdir(), 'weakspot-lanes-'));
  const prepared = path.join(out, 'prepared.txt');
  try {
    const { report, md } = await run(['packages/app/src/price.ts', 'packages/app/src/calc.ts', 'packages/e2e-only/src/only.ts'], 'fallback', out, prepared);
    assert.deepEqual(report.packages.map((p) => [p.lane, p.name, p.targets]), [
      ['unit', 'fixture-lanes-app', ['packages/app/src/price.ts']],
      ['e2e', 'fixture-lanes-app', ['packages/app/src/calc.ts']],
      ['e2e', 'fixture-lanes-e2e-only', ['packages/e2e-only/src/only.ts']],
    ]);
    assert.deepEqual(report.packages[1]!.specs, ['packages/app/e2e/calc.e2e.ts']);
    assert.deepEqual(report.viaFallback, [
      { file: 'packages/app/src/calc.ts', lane: 'e2e' },
      { file: 'packages/e2e-only/src/only.ts', lane: 'e2e' },
    ]);
    assert.deepEqual(report.untested, []);
    assert.deepEqual(report.noTestConfig, [], 'a package with only a lane config is still a package');
    assert.ok((report.packages[2]!.counts['Killed'] ?? 0) >= 3, `e2e-only killed: ${JSON.stringify(report.packages[2]!.counts)}`);
    const envModules = readdirSync(path.join(out, 'engine'))
      .filter((d) => d.endsWith('-e2e'))
      .map((d) => readFileSync(path.join(out, 'engine', d, 'weakspot-env.mjs'), 'utf8').match(/String\((\d+) \+/)![1]);
    assert.equal(new Set(envModules).size, 2, `the two e2e engine processes got different worker offsets: ${envModules.join(', ')}`);
    assert.deepEqual(report.warnings, []);
    assert.equal(readFileSync(prepared, 'utf8').trim(), 'prepared', 'the prepare command ran in the package');
    const e2eCounts = report.packages[1]!.counts;
    assert.ok((e2eCounts['Killed'] ?? 0) >= 4, `e2e killed: ${JSON.stringify(e2eCounts)}`);
    assert.ok(report.mutants.filter((m) => m.file === 'packages/app/src/calc.ts').every((m) => m.lane === 'e2e'));
    const weak = report.survivors.find((s) => s.mutant.file === 'packages/app/src/calc.ts' && s.kind === 'weakAssertion' && s.mutant.start.line === 8);
    assert.ok(weak, `isEven's weak test leaves a survivor: ${JSON.stringify(report.survivors.map((s) => [s.mutant.start.line, s.kind]))}`);
    assert.ok(report.findings.some((f) => f.id === weak!.mutant.id && /in the e2e lane/.test(f.evidence)));
    assert.match(md, /## No unit spec, checked by a later lane\n\n- packages\/app\/src\/calc\.ts: e2e lane/);
    assert.match(md, /### packages\/app\/src\/calc\.ts \(e2e lane\)/);
    assert.ok(existsSync(path.join(out, 'engine')), 'engine dirs under out');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('lanes: naming a lane runs it for every file; a file its specs never load is all no-coverage, not an error', { timeout: 300_000 }, async () => {
  const out = mkdtempSync(path.join(os.tmpdir(), 'weakspot-lanes-'));
  try {
    const { report } = await run(['packages/app/src/price.ts', 'packages/app/src/calc.ts'], ['e2e'], out, path.join(out, 'prepared.txt'));
    assert.deepEqual(report.packages.map((p) => [p.lane, p.targets]), [['e2e', ['packages/app/src/price.ts', 'packages/app/src/calc.ts']]]);
    assert.ok(report.findings.every((f) => f.kind !== 'untested'));
    assert.deepEqual(report.viaFallback, []);
    const price = report.survivors.filter((s) => s.mutant.file === 'packages/app/src/price.ts');
    assert.ok(price.length > 0 && price.every((s) => s.kind === 'noCoverage'), 'price.ts is unreached by the e2e spec');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
