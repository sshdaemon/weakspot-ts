import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { FsPackageLocator } from '../../src/adapters/fs/package-locator.ts';
import { ImportSpecFinder } from '../../src/adapters/ts/import-spec-finder.ts';
import { CommandSpecFinder } from '../../src/adapters/shell/command-spec-finder.ts';
import { FirstSpecFinder } from '../../src/adapters/spec/first-spec-finder.ts';
import { laneFinder } from '../../src/adapters/spec/lane-finder.ts';
import { DEFAULT_SPEC_PATTERNS } from '../../src/change/spec-kind.ts';
import type { LaneConfig } from '../../src/cli/config.ts';
import { applyChangedSpecRule } from '../../src/change/changed-spec.ts';
import { parseUnifiedDiff } from '../../src/change/hunks.ts';
import { DEFAULT_SKIP } from '../../src/change/triage.ts';

const fixtures = path.resolve(import.meta.dirname, '../../fixtures');
const locator = new FsPackageLocator();

const e2eLane = (specs: LaneConfig['specs']): LaneConfig => ({ name: 'e2e', config: 'vitest-e2e.config.ts', specs, envPerWorker: {}, timeoutMs: 1, concurrency: 1 });

test('import spec finder: a spec importing the file directly, at depth 1', () => {
  const repo = path.join(fixtures, 'vitest-basic');
  const pkg = locator.packageOf(repo, path.join(repo, 'src/price.ts'))!;
  const set = new ImportSpecFinder(1).find(repo, pkg, 'src/price.ts', []);
  assert.deepEqual(set, { file: 'src/price.ts', specs: ['src/price.test.ts'], how: 'imports' });
});

test('import spec finder: import(), require() and vi.importActual() reach a module; vi.doMock() replaces it', () => {
  const repo = path.join(fixtures, 'vitest-basic');
  const pkg = locator.packageOf(repo, path.join(repo, 'src/loaded.ts'))!;
  const set = new ImportSpecFinder(1).find(repo, pkg, 'src/loaded.ts', []);
  assert.deepEqual(set.specs, ['src/loaded-actual.test.ts', 'src/loaded-import.test.ts', 'src/loaded-require.test.ts']);
});

test('import spec finder: a value re-export links a barrel spec to the source at depth 2; a type-only re-export does not', () => {
  const repo = path.join(fixtures, 'vitest-basic');
  const pkg = locator.packageOf(repo, path.join(repo, 'src/shape.ts'))!;
  const finder = new ImportSpecFinder(2);
  assert.deepEqual(finder.find(repo, pkg, 'src/shape.ts', []).specs, ['src/barrel.test.ts']);
  assert.deepEqual(finder.find(repo, pkg, 'src/shape-types.ts', []).specs, []);
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
  const patterns = { specDepth: 1, ...DEFAULT_SPEC_PATTERNS };
  assert.ok(laneFinder(e2eLane(['imports']), patterns) instanceof ImportSpecFinder);
  const chain = laneFinder(e2eLane(['imports', { map: [['^packages/([^/]+)/src/', 'packages/$1/e2e/**/*.e2e.ts']] }]), patterns);
  assert.ok(chain instanceof FirstSpecFinder);
  assert.equal(chain.find(root, pkg, 'packages/app/src/calc.ts', []).how, 'imports');
  assert.equal(chain.find(root, pkg, 'packages/app/src/price.ts', []).how, 'map', 'no e2e spec imports price.ts, so the mapping answers');
  assert.ok(laneFinder(e2eLane([{ command: 'echo' }]), patterns) instanceof CommandSpecFinder);
  const toCommand = laneFinder(e2eLane(['imports', { command: "printf 'packages/app/e2e/calc.e2e.ts'" }]), patterns);
  assert.deepEqual(toCommand.find(root, pkg, 'packages/app/src/price.ts', []), { file: 'packages/app/src/price.ts', specs: ['packages/app/e2e/calc.e2e.ts'], how: 'command' });
});

test('importLines: import declarations, multi-line ones included, and blank lines; nothing else', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'weakspot-import-lines-'));
  try {
    const spec = path.join(dir, 'a.test.ts');
    writeFileSync(spec, ["import { a } from './a';", 'import {', '  b,', "} from './b';", '   ', "test('x', () => {});", "import c = require('./c');", ''].join('\n'));
    assert.deepEqual([...new ImportSpecFinder().importLines(spec)].toSorted((x, y) => x - y), [1, 2, 3, 4, 5, 7, 8], 'a line of spaces counts as blank');
    assert.deepEqual(new ImportSpecFinder().importLines(path.join(dir, 'missing.ts')).size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('specifier cache: a second run parses nothing, an edited file is parsed again, and the answers do not change', () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'weakspot-cache-repo-'));
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), 'weakspot-cache-'));
  try {
    cpSync(path.join(fixtures, 'vitest-basic'), repo, { recursive: true, filter: (src) => !src.endsWith('node_modules') });
    const pkg = locator.packageOf(repo, path.join(repo, 'src/price.ts'))!;
    const first = new ImportSpecFinder(2, DEFAULT_SPEC_PATTERNS, 'unit', cacheDir);
    const answer = first.find(repo, pkg, 'src/format.ts', []);
    assert.ok(first.parsedCount(pkg) > 5, `first run parses every source: ${first.parsedCount(pkg)}`);
    const second = new ImportSpecFinder(2, DEFAULT_SPEC_PATTERNS, 'unit', cacheDir);
    assert.deepEqual(second.find(repo, pkg, 'src/format.ts', []), answer);
    assert.equal(second.parsedCount(pkg), 0);
    writeFileSync(path.join(repo, 'src/via.test.ts'), `${readFileSync(path.join(repo, 'src/via.test.ts'), 'utf8')}\n// edited\n`);
    const third = new ImportSpecFinder(2, DEFAULT_SPEC_PATTERNS, 'unit', cacheDir);
    assert.deepEqual(third.find(repo, pkg, 'src/format.ts', []), answer);
    assert.equal(third.parsedCount(pkg), 1);
    writeFileSync(path.join(readdirSync(path.join(cacheDir, 'specifiers')).map((f) => path.join(cacheDir, 'specifiers', f))[0]!), '{not json');
    const broken = new ImportSpecFinder(2, DEFAULT_SPEC_PATTERNS, 'unit', cacheDir);
    assert.deepEqual(broken.find(repo, pkg, 'src/format.ts', []), answer, 'an unreadable cache is ignored');
    const cacheFile = readdirSync(path.join(cacheDir, 'specifiers')).map((f) => path.join(cacheDir, 'specifiers', f))[0]!;
    const keys = Object.keys(JSON.parse(readFileSync(cacheFile, 'utf8')) as Record<string, unknown>);
    writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(keys.map((k) => [k, { imports: 'x', mocked: [] }]))));
    const misshapen = new ImportSpecFinder(2, DEFAULT_SPEC_PATTERNS, 'unit', cacheDir);
    assert.deepEqual(misshapen.find(repo, pkg, 'src/format.ts', []), answer, 'a cache in another shape is ignored');
    assert.ok(misshapen.parsedCount(pkg) > 5);
    new ImportSpecFinder(2, DEFAULT_SPEC_PATTERNS, 'e2e', cacheDir).find(repo, pkg, 'src/format.ts', []);
    assert.deepEqual(readdirSync(path.join(cacheDir, 'specifiers')).map((f) => f.split('-').slice(0, 2).join('-')).toSorted(), ['v2-e2e', 'v2-unit'], 'each finder kind keeps its own versioned file');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('onlyImports: whole import declarations and blank lines only; a fragment or any other statement is not', () => {
  const f = new ImportSpecFinder();
  assert.ok(f.onlyImports("import { a } from './a';\n\nimport type { B } from './b';"));
  assert.ok(f.onlyImports("import {\n  a,\n} from './a';"));
  assert.ok(f.onlyImports('   '));
  assert.ok(!f.onlyImports('  b,'), 'part of a multi-line import is not provably an import');
  assert.ok(!f.onlyImports("} from './b';"));
  assert.ok(!f.onlyImports("test('b', () => {});"));
  assert.ok(!f.onlyImports("import { a } from './a';\nconst x = 1;"));
});

test('deleting a test and its now-unused import is a spec change: real diff, real import reader, real rule', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'weakspot-drop-test-'));
  try {
    const spec = path.join(dir, 'app/src/a.test.ts');
    mkdirSync(path.dirname(spec), { recursive: true });
    writeFileSync(spec, ["import { a } from './a';", '', "test('a', () => {", '  expect(a()).toBe(1);', '});', ''].join('\n'));
    const diff = [
      'diff --git a/app/src/a.test.ts b/app/src/a.test.ts',
      '--- a/app/src/a.test.ts',
      '+++ b/app/src/a.test.ts',
      '@@ -1 +1 @@',
      "-import { a, b } from './a';",
      "+import { a } from './a';",
      '@@ -6,4 +5,0 @@',
      '-',
      "-test('b', () => {",
      '-  expect(b()).toBe(2);',
      '-});',
    ].join('\n');
    const finder = new ImportSpecFinder();
    const pkg = { dir: path.join(dir, 'app'), name: 'app', testConfig: path.join(dir, 'app/vitest.config.ts') };
    const out = applyChangedSpecRule({
      repoRoot: dir,
      changed: parseUnifiedDiff(diff),
      kept: [],
      specs: new Map(),
      packages: new Map(),
      skip: DEFAULT_SKIP,
      patterns: DEFAULT_SPEC_PATTERNS,
      importsOf: () => ({ pkg, imports: [path.join(dir, 'app/src/a.ts')] }),
      importLines: (c) => finder.importLines(path.join(dir, c.path)),
      onlyImports: (text) => finder.onlyImports(text),
    });
    assert.deepEqual(out.importOnly, []);
    assert.deepEqual(out.viaChangedSpec, ['app/src/a.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
