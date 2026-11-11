import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FsPackageLocator } from '../../src/adapters/fs/package-locator.ts';
import { ImportSpecFinder } from '../../src/adapters/ts/import-spec-finder.ts';

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
