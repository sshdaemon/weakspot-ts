import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { FsPackageLocator } from '../src/adapters/fs/package-locator.ts';
import { JestRunner, jestShimSource } from '../src/adapters/jest/jest-runner.ts';
import { RunnerSet, UnsupportedByRunnerError } from '../src/adapters/runner-set.ts';
import { VitestRunner } from '../src/adapters/vitest/vitest-runner.ts';
import { exitCodeFor } from '../src/cli/exit-codes.ts';
import type { RunResult, TestRunner } from '../src/ports/test-runner.ts';

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'weakspot-jest-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const pkg = (testConfig: string) => ({ name: 'app', dir: '/repo/app', testConfig: `/repo/app/${testConfig}` });

test('detect: any jest* file in a config format, a jest key in package.json; never a Vitest config', () => {
  const jest = new JestRunner();
  for (const name of ['jest.config.js', 'jest.config.ts', 'jest.config.mjs', 'jest.config.cjs', 'jest.config.mts', 'jest.config.json', 'jest-e2e.config.js', 'test/jest-e2e.json']) assert.equal(jest.detect(pkg(name)), true, name);
  for (const name of ['vitest.config.ts', 'config.jest.js', 'jest.config.yaml', 'setup-jest.ts']) assert.equal(jest.detect(pkg(name)), false, name);
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', jest: { testEnvironment: 'node' } }));
  assert.equal(jest.detect({ name: 'x', dir, testConfig: path.join(dir, 'package.json') }), true);
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
  assert.equal(jest.detect({ name: 'x', dir, testConfig: path.join(dir, 'package.json') }), false);
  writeFileSync(path.join(dir, 'package.json'), '{ broken');
  assert.equal(jest.detect({ name: 'x', dir, testConfig: path.join(dir, 'package.json') }), false);
});

/** A package folder in the temp dir with the tool's Jest linked in, as a project has its own. */
function jestPackage(files: Record<string, string>): string {
  const pkgDir = path.join(dir, 'repo', 'app');
  mkdirSync(pkgDir, { recursive: true });
  symlinkSync(path.resolve(import.meta.dirname, '..', 'node_modules'), path.join(pkgDir, 'node_modules'));
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(pkgDir, name), text);
  return pkgDir;
}

async function evaluated(pkgDir: string, config: string, opts: Parameters<JestRunner['writeShim']>[1]): Promise<Record<string, unknown>> {
  const shim = new JestRunner().writeShim({ name: 'app', dir: pkgDir, testConfig: path.join(pkgDir, config) }, opts, path.join(dir, 'work', `${config}.shim.mts`));
  assert.equal(path.extname(shim), '.mjs', 'Jest reads .mjs, so the shim takes that extension');
  return ((await import(shim)) as { default: Record<string, unknown> }).default;
}

test('shim text: the env module first, the package config read with the project\'s own Jest, the root and specs given', () => {
  const src = jestShimSource(pkg('jest.config.ts'), { root: 'cwd', include: ['src/[id]/a.test.ts'] });
  assert.ok(src.indexOf("import './weakspot-env.mjs'") < src.indexOf('readInitialOptions'), 'the env module loads before the package config');
  assert.match(src, /const CONFIG = "\/repo\/app\/jest\.config\.ts";/);
  assert.match(src, /createRequire\(createRequire\(fromPkg\.resolve\('jest'\)\)\.resolve\('jest-cli'\)\)\('jest-config'\)/);
  assert.match(src, /const root = process\.cwd\(\);/);
  assert.match(src, /const include = \["src\/\[id\]\/a\.test\.ts"\];/);
  assert.match(jestShimSource(pkg('jest.config.js'), { root: '/sandbox', include: undefined }), /const root = "\/sandbox";[\s\S]*const include = undefined;/);
});

test('shim: paths inside the package move onto the root, paths outside it become real, module names stay, global setup stays real', async () => {
  const pkgDir = jestPackage({
    'jest.config.cjs': `module.exports = async () => ({
      rootDir: 'src', testRegex: 'x', roots: ['<rootDir>'], projects: ['a'], testEnvironment: 'node',
      preset: '../../jest.preset.js',
      moduleNameMapper: { '^@/(.*)$': '<rootDir>/$1', '^shared$': '<rootDir>/../../shared/index.ts', '^lib$': 'some-lib' },
      transform: { '^.+\\\\.ts$': ['babel-jest', { a: 1 }], '^.+\\\\.svg$': '<rootDir>/../svg-transform.js' },
      setupFiles: ['${path.join(dir, 'repo', 'app')}/setup.js', '../../root-setup.js'],
      setupFilesAfterEnv: ['<rootDir>/after.js'],
      snapshotSerializers: ['../../serializer.js', '<rootDir>/own-serializer.js'],
      reporters: ['default', ['../../reporter.js', { out: 'r' }]],
      haste: { hasteImplModulePath: '<rootDir>/haste.js' },
      globalSetup: '<rootDir>/../global-setup.js', globalTeardown: 'some-package/teardown',
    });\n`,
  });
  // Relative paths resolve against the package's rootDir, app/src, so ../../ is the repo folder.
  const repoDir = path.dirname(pkgDir);
  const cfg = await evaluated(pkgDir, 'jest.config.cjs', { root: '/sandbox', include: ['src/a.test.ts'], env: { DB: 'db_{worker}' }, workerIdVariable: 'W', workerOffset: 100 });
  assert.deepEqual(cfg, {
    testEnvironment: 'node',
    preset: `./${path.relative('/sandbox/src', path.join(repoDir, 'jest.preset.js'))}`,
    setupFiles: ['/sandbox/setup.js', path.join(repoDir, 'root-setup.js')],
    setupFilesAfterEnv: ['/sandbox/src/after.js'],
    snapshotSerializers: [path.join(repoDir, 'serializer.js'), '/sandbox/src/own-serializer.js'],
    reporters: ['default', [path.join(repoDir, 'reporter.js'), { out: 'r' }]],
    haste: { hasteImplModulePath: '/sandbox/src/haste.js' },
    moduleNameMapper: { '^@/(.*)$': '/sandbox/src/$1', '^shared$': path.join(repoDir, 'shared/index.ts'), '^lib$': 'some-lib' },
    transform: { '^.+\\.ts$': ['babel-jest', { a: 1 }], '^.+\\.svg$': '/sandbox/svg-transform.js' },
    rootDir: '/sandbox/src',
    collectCoverage: false,
    watchman: false,
    roots: ['/sandbox'],
    testMatch: ['/sandbox/src/a.test.ts'],
    testRegex: [],
    globalSetup: path.join(pkgDir, 'global-setup.js'),
    globalTeardown: 'some-package/teardown',
  });
  assert.equal(process.env['DB'], 'db_100', 'the env module ran first, with the run\'s worker offset');
  delete process.env['DB'];
});

test('shim: a TypeScript config, a JSON one and a jest key in package.json all load through Jest', async () => {
  const pkgDir = jestPackage({
    'package.json': JSON.stringify({ name: 'app', type: 'commonjs', jest: { testEnvironment: 'jsdom' } }),
    'jest.config.ts': "const dir: string = __dirname;\nmodule.exports = { testEnvironment: 'node', displayName: dir.length > 0 ? 'ts' : 'x' };\n",
    'jest.config.json': JSON.stringify({ displayName: 'json' }),
  });
  assert.deepEqual([(await evaluated(pkgDir, 'jest.config.ts', { root: pkgDir, include: [] }))['displayName'], (await evaluated(pkgDir, 'jest.config.json', { root: pkgDir, include: [] }))['displayName']], ['ts', 'json']);
  assert.equal((await evaluated(pkgDir, 'package.json', { root: pkgDir, include: [] }))['testEnvironment'], 'jsdom');
});

test('shim: without specs the package keeps its own test selection and roots', async () => {
  const pkgDir = jestPackage({ 'jest.config.json': JSON.stringify({ testMatch: ['<rootDir>/e2e/**/*.e2e.ts'], roots: ['<rootDir>/e2e'] }) });
  const cfg = await evaluated(pkgDir, 'jest.config.json', { root: pkgDir, include: undefined });
  assert.deepEqual([cfg['rootDir'], cfg['roots'], cfg['testMatch'], 'testRegex' in cfg], [pkgDir, [path.join(pkgDir, 'e2e')], ['<rootDir>/e2e/**/*.e2e.ts'], false]);
});

test('shim: a spec path with glob characters matches itself and nothing else', async () => {
  const pkgDir = jestPackage({ 'jest.config.json': '{}' });
  const cfg = await evaluated(pkgDir, 'jest.config.json', { root: '/sandbox', include: ['src/[id]/(group)/a.test.ts'] });
  const { globsToMatcher } = (await import('jest-util')) as unknown as { globsToMatcher: (globs: string[]) => (p: string) => boolean };
  const matches = globsToMatcher(cfg['testMatch'] as string[]);
  assert.deepEqual([matches('/sandbox/src/[id]/(group)/a.test.ts'), matches('/sandbox/src/i/(group)/a.test.ts'), matches('/sandbox/src/d/group/a.test.ts')], [true, false, false]);
});

test('engine config: Stryker\'s Jest runner with the shim, all specs per mutant (the set is already narrow)', () => {
  assert.deepEqual(new JestRunner().engineConfig(pkg('jest.config.js'), '/w/jest.shim.mjs'), { testRunner: 'jest', jest: { projectType: 'custom', configFile: '/w/jest.shim.mjs', enableFindRelatedTests: false } });
});

const ok: RunResult = { passed: 1, failed: 0, failedFiles: 0, timedOut: false, durationMs: 1, output: '' };

test('runner set: each package goes to the runner that knows its config; a map is refused for a runner that cannot record', async () => {
  const calls: string[] = [];
  const fake = (name: string, pattern: RegExp, record: boolean): TestRunner => ({
    name,
    detect: (p) => pattern.test(p.testConfig),
    writeShim: (_p, _o, out) => `${out}.${name}`,
    engineConfig: () => ({ testRunner: name }),
    run: () => {
      calls.push(name);
      return Promise.resolve(ok);
    },
    ...(record ? { recordCoverage: () => Promise.resolve({ executed: new Map(), result: ok }) } : {}),
  });
  const set = new RunnerSet([fake('vitest', /vitest/, true), fake('jest', /jest/, false)]);
  assert.equal(set.name, 'vitest or jest');
  const v = pkg('vitest.config.ts');
  const j = pkg('jest.config.ts');
  assert.deepEqual([set.detect(v), set.detect(j), set.detect(pkg('karma.conf.js'))], [true, true, false]);
  assert.deepEqual([set.writeShim(v, { root: 'cwd', include: [] }, '/s'), set.writeShim(j, { root: 'cwd', include: [] }, '/s')], ['/s.vitest', '/s.jest']);
  assert.deepEqual([set.engineConfig(v, '/s'), set.engineConfig(j, '/s')], [{ testRunner: 'vitest' }, { testRunner: 'jest' }]);
  await set.run(j, '/s', '/c', 1);
  await set.run(v, '/s', '/c', 1);
  assert.deepEqual(calls, ['jest', 'vitest']);
  assert.deepEqual([set.coverageRefusal(v), set.coverageRefusal(j), set.coverageRefusal(pkg('karma.conf.js'))], [undefined, 'app runs its tests with jest, which cannot record what each spec ran; a coverage map needs a vitest package', 'app has karma.conf.js, which is not a vitest or jest config']);
  assert.deepEqual((await set.recordCoverage(v, { workDir: '/w', env: {} })).result, ok);
  assert.throws(() => set.recordCoverage(j, { workDir: '/w', env: {} }), (e: unknown) => e instanceof UnsupportedByRunnerError && exitCodeFor(e) === 2 && e.message === 'app runs its tests with jest, which cannot record what each spec ran; a coverage map needs a vitest package');
  assert.throws(() => set.run(pkg('karma.conf.js'), '/s', '/c', 1), /no runner knows \/repo\/app\/karma\.conf\.js/);
});

test('the real runners split the config files between them', () => {
  const set = new RunnerSet([new VitestRunner(), new JestRunner()]);
  assert.equal(set.detect(pkg('vitest.config.mts')), true);
  assert.equal(set.detect(pkg('jest.config.cjs')), true);
  assert.equal(new VitestRunner().detect(pkg('jest.config.ts')), false);
});

test('package locator: a jest.config file or a jest key in package.json makes a package, Vitest\'s config first', () => {
  const app = path.join(dir, 'app');
  const both = path.join(dir, 'both');
  const plain = path.join(dir, 'plain');
  for (const d of [app, both, plain]) mkdirSync(path.join(d, 'src'), { recursive: true });
  writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'app', jest: {} }));
  writeFileSync(path.join(both, 'package.json'), JSON.stringify({ name: 'both' }));
  writeFileSync(path.join(both, 'jest.config.js'), '');
  writeFileSync(path.join(both, 'vitest.config.ts'), '');
  writeFileSync(path.join(plain, 'package.json'), JSON.stringify({ name: 'plain' }));
  writeFileSync(path.join(plain, 'jest.config.ts'), '');
  const setupOnly = path.join(dir, 'setup-only');
  mkdirSync(path.join(setupOnly, 'src'), { recursive: true });
  writeFileSync(path.join(setupOnly, 'package.json'), JSON.stringify({ name: 'setup-only' }));
  writeFileSync(path.join(setupOnly, 'jest.setup.ts'), '');
  const locator = new FsPackageLocator();
  assert.notEqual(locator.packageOf(dir, path.join(setupOnly, 'src/a.ts'))?.dir, setupOnly, 'a jest.setup file alone makes no package');
  assert.equal(locator.packageOf(dir, path.join(app, 'src/a.ts'))?.testConfig, path.join(app, 'package.json'));
  assert.equal(locator.packageOf(dir, path.join(both, 'src/a.ts'))?.testConfig, path.join(both, 'vitest.config.ts'));
  assert.equal(locator.packageOf(dir, path.join(plain, 'src/a.ts'))?.testConfig, path.join(plain, 'jest.config.ts'));
});

test('package locator: Jest beats a Vite build config, a jest key beats a lane config, and a plain or broken package.json is no package', () => {
  const viteApp = path.join(dir, 'vite-app');
  const keyed = path.join(dir, 'keyed');
  for (const d of [viteApp, keyed]) mkdirSync(path.join(d, 'src'), { recursive: true });
  writeFileSync(path.join(viteApp, 'package.json'), '{}');
  writeFileSync(path.join(viteApp, 'vite.config.ts'), '');
  writeFileSync(path.join(viteApp, 'jest.config.js'), '');
  writeFileSync(path.join(keyed, 'package.json'), JSON.stringify({ jest: {} }));
  writeFileSync(path.join(keyed, 'jest.e2e.config.js'), '');
  for (const nested of ['plain', 'broken']) mkdirSync(path.join(keyed, 'src', nested, 'deep'), { recursive: true });
  writeFileSync(path.join(keyed, 'src/plain/package.json'), JSON.stringify({ name: 'plain' }));
  writeFileSync(path.join(keyed, 'src/broken/package.json'), '{ broken');
  const nest = path.join(dir, 'nest');
  mkdirSync(path.join(nest, 'test'), { recursive: true });
  mkdirSync(path.join(nest, 'src'));
  writeFileSync(path.join(nest, 'package.json'), JSON.stringify({ name: 'nest' }));
  writeFileSync(path.join(nest, 'test/jest-e2e.json'), '{}');
  assert.equal(new FsPackageLocator(['test/jest-e2e.json']).packageOf(dir, path.join(nest, 'src/a.ts'))?.testConfig, path.join(nest, 'test/jest-e2e.json'), 'a lane config may sit in a folder of the package');
  const locator = new FsPackageLocator(['jest.e2e.config.js']);
  assert.equal(locator.packageOf(dir, path.join(viteApp, 'src/a.ts'))?.testConfig, path.join(viteApp, 'jest.config.js'));
  assert.equal(locator.packageOf(dir, path.join(keyed, 'src/a.ts'))?.testConfig, path.join(keyed, 'package.json'));
  assert.equal(locator.packageOf(dir, path.join(keyed, 'src/plain/deep/a.ts'))?.dir, keyed, 'a package.json with no config or jest key is passed by');
  assert.equal(locator.packageOf(dir, path.join(keyed, 'src/broken/deep/a.ts'))?.dir, keyed);
  const viteOnly = path.join(dir, 'vite-only');
  mkdirSync(viteOnly);
  writeFileSync(path.join(viteOnly, 'package.json'), '{}');
  writeFileSync(path.join(viteOnly, 'vite.config.mts'), '');
  assert.equal(locator.packageOf(dir, path.join(viteOnly, 'a.ts'))?.testConfig, path.join(viteOnly, 'vite.config.mts'), 'a Vite config alone still means Vitest');
});
