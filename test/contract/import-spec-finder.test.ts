import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { FsPackageLocator } from '../../src/adapters/fs/package-locator.ts';
import { ImportSpecFinder } from '../../src/adapters/ts/import-spec-finder.ts';
import { CommandSpecFinder } from '../../src/adapters/shell/command-spec-finder.ts';
import { FirstSpecFinder } from '../../src/adapters/spec/first-spec-finder.ts';
import { laneFinder } from '../../src/adapters/spec/lane-finder.ts';
import { DEFAULT_SPEC_PATTERNS } from '../../src/change/spec-kind.ts';
import type { LaneConfig } from '../../src/cli/config.ts';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures');
const locator = new FsPackageLocator();

test('import spec finder: a spec importing the file directly, at depth 1', () => {
  const repo = path.join(fixtures, 'vitest-basic');
  const pkg = locator.packageOf(repo, path.join(repo, 'src/price.ts'))!;
  const set = new ImportSpecFinder(1).find(repo, pkg, 'src/price.ts', []);
  assert.deepEqual(set, { file: 'src/price.ts', specs: ['src/price.test.ts'], how: 'imports' });
});

test('import spec finder: depth 2 adds the spec of an intermediate module', () => {
  const repo = path.join(fixtures, 'vitest-basic');
  const pkg = locator.packageOf(repo, path.join(repo, 'src/price.ts'))!;
  const set = new ImportSpecFinder(2).find(repo, pkg, 'src/price.ts', []);
  assert.deepEqual(set.specs, ['src/format.test.ts', 'src/price.test.ts']);
});

test('import spec finder: resolves a tsconfig paths alias', () => {
  const repo = path.join(fixtures, 'vitest-alias');
  const pkg = locator.packageOf(repo, path.join(repo, 'src/price.ts'))!;
  const set = new ImportSpecFinder(1).find(repo, pkg, 'src/price.ts', []);
  assert.deepEqual(set.specs, ['src/price.test.ts']);
});

test('import spec finder: importsOf lists the sources a spec imports, not other specs', () => {
  const repo = path.join(fixtures, 'vitest-basic');
  const pkg = locator.packageOf(repo, path.join(repo, 'src/format.ts'))!;
  const imports = new ImportSpecFinder().importsOf(repo, pkg, path.join(repo, 'src/format.test.ts'));
  assert.deepEqual(imports.map((p) => path.relative(repo, p)), ['src/format.ts']);
});

test('import spec finder: a spec that mocks a module is not that module\'s spec, and a type-only import does not count', () => {
  const repo = path.join(fixtures, 'vitest-basic');
  const finder = new ImportSpecFinder(1);
  const mocked = locator.packageOf(repo, path.join(repo, 'src/mocked.ts'))!;
  assert.deepEqual(finder.find(repo, mocked, 'src/mocked.ts', []).specs, []);
  assert.deepEqual(finder.find(repo, mocked, 'src/types-only.ts', []).specs, []);
  assert.deepEqual(finder.importsOf(repo, mocked, path.join(repo, 'src/mocked.test.ts')), []);
});

test('import spec finder: a spec that mocks the target through an intermediate module is skipped at depth 2', () => {
  const repo = path.join(fixtures, 'vitest-basic');
  const pkg = locator.packageOf(repo, path.join(repo, 'src/mocked.ts'))!;
  assert.deepEqual(new ImportSpecFinder(2).find(repo, pkg, 'src/mocked.ts', []).specs, []);
  assert.deepEqual(new ImportSpecFinder(1).find(repo, pkg, 'src/via.ts', []).specs, ['src/via.test.ts']);
});

test('import spec finder: a module mocked through an alias but imported relatively is still mocked', () => {
  const repo = path.join(fixtures, 'vitest-alias');
  const pkg = locator.packageOf(repo, path.join(repo, 'src/price.ts'))!;
  const finder = new ImportSpecFinder(1);
  assert.deepEqual(finder.find(repo, pkg, 'src/price.ts', []).specs, ['src/price.test.ts']);
  assert.deepEqual(finder.importsOf(repo, pkg, path.join(repo, 'src/alias-mock.test.ts')), []);
});

test('import spec finder: spec patterns are matched on the repo-relative path, so an anchored pattern works', () => {
  const repo = path.join(fixtures, 'vitest-basic');
  const pkg = locator.packageOf(repo, path.join(repo, 'src/price.ts'))!;
  const anchored = new ImportSpecFinder(1, { specPattern: '^src/.*\\.test\\.ts$', e2ePattern: '\\.e2e\\.ts$' });
  assert.deepEqual(anchored.find(repo, pkg, 'src/price.ts', []).specs, ['src/price.test.ts']);
});

test('an e2e-kind finder names the e2e specs that import a file and ignores unit specs', () => {
  const root = path.join(fixtures, 'vitest-lanes');
  const pkg = { dir: path.join(root, 'packages/app'), name: 'fixture-lanes-app', testConfig: path.join(root, 'packages/app/vitest-e2e.config.ts') };
  const e2e = new ImportSpecFinder(1, DEFAULT_SPEC_PATTERNS, 'e2e');
  assert.deepEqual(e2e.find(root, pkg, 'packages/app/src/calc.ts', []), { file: 'packages/app/src/calc.ts', specs: ['packages/app/e2e/calc.e2e.ts'], how: 'imports' });
  assert.deepEqual(e2e.find(root, pkg, 'packages/app/src/price.ts', []).specs, [], 'price.test.ts is a unit spec');
  const unit = new ImportSpecFinder(1, DEFAULT_SPEC_PATTERNS);
  assert.deepEqual(unit.find(root, pkg, 'packages/app/src/calc.ts', []).specs, [], 'the unit kind never names an e2e spec');
});

test('laneFinder: one source is that finder, several become a first-wins chain that falls through to the mapping', () => {
  const root = path.join(fixtures, 'vitest-lanes');
  const pkg = { dir: path.join(root, 'packages/app'), name: 'fixture-lanes-app', testConfig: path.join(root, 'packages/app/vitest-e2e.config.ts') };
  const lane = (specs: LaneConfig['specs']): LaneConfig => ({ name: 'e2e', config: 'vitest-e2e.config.ts', specs, envPerWorker: {}, timeoutMs: 1, concurrency: 1 });
  const patterns = { specDepth: 1, ...DEFAULT_SPEC_PATTERNS };
  assert.ok(laneFinder(lane(['imports']), patterns) instanceof ImportSpecFinder);
  const chain = laneFinder(lane(['imports', { map: [['^packages/([^/]+)/src/', 'packages/$1/e2e/**/*.e2e.ts']] }]), patterns);
  assert.ok(chain instanceof FirstSpecFinder);
  assert.equal(chain.find(root, pkg, 'packages/app/src/calc.ts', []).how, 'imports');
  assert.equal(chain.find(root, pkg, 'packages/app/src/price.ts', []).how, 'map', 'no e2e spec imports price.ts, so the mapping answers');
  assert.ok(laneFinder(lane([{ command: 'echo' }]), patterns) instanceof CommandSpecFinder);
  const toCommand = laneFinder(lane(['imports', { command: "printf 'packages/app/e2e/calc.e2e.ts'" }]), patterns);
  assert.deepEqual(toCommand.find(root, pkg, 'packages/app/src/price.ts', []), { file: 'packages/app/src/price.ts', specs: ['packages/app/e2e/calc.e2e.ts'], how: 'command' });
});
