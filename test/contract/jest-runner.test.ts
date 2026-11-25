import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, test } from 'vitest';
import { JestRunner } from '../../src/adapters/jest/jest-runner.ts';

const fixtures = path.resolve(import.meta.dirname, '../../fixtures');
const toolModules = path.resolve(fixtures, '..', 'node_modules');
let repo: string;
let out: string;

beforeAll(() => {
  repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'weakspot-jest-')));
  out = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'weakspot-jest-out-')));
  cpSync(path.join(fixtures, 'jest-basic'), repo, { recursive: true, filter: (src) => !src.endsWith('node_modules') });
  // A folder of links, as a real install is: the engine's sandbox drops a node_modules that is one link.
  mkdirSync(path.join(repo, 'node_modules'));
  for (const entry of readdirSync(toolModules)) symlinkSync(path.join(toolModules, entry), path.join(repo, 'node_modules', entry));
});
afterAll(() => {
  for (const d of [repo, out]) rmSync(d, { recursive: true, force: true });
});

test('jest runner: the package\'s TypeScript config through the shim; a spec file that fails to load is a failed file', { timeout: 60_000 }, async () => {
  const runner = new JestRunner();
  const pkg = { name: 'fixture', dir: repo, testConfig: path.join(repo, 'jest.config.ts') };
  const green = await runner.run(pkg, runner.writeShim(pkg, { root: repo, include: ['src/price.test.ts'] }, path.join(out, 'shims', 'green.shim.mts')), repo, 50_000);
  assert.deepEqual([green.passed, green.failed, green.failedFiles], [4, 0, 0]);
  writeFileSync(path.join(repo, 'src/broken.test.ts'), "import './missing-module';\nit('never runs', () => {});\n");
  try {
    const mixed = await runner.run(pkg, runner.writeShim(pkg, { root: repo, include: ['src/price.test.ts', 'src/broken.test.ts'] }, path.join(out, 'shims', 'mixed.shim.mts')), repo, 50_000);
    assert.deepEqual([mixed.passed, mixed.failed, mixed.failedFiles], [4, 0, 1]);
  } finally {
    rmSync(path.join(repo, 'src/broken.test.ts'));
  }
});

test('jest runner: a spec that leaves a timer running still ends well before the time limit', { timeout: 60_000 }, async () => {
  const runner = new JestRunner();
  const pkg = { name: 'fixture', dir: repo, testConfig: path.join(repo, 'jest.config.ts') };
  writeFileSync(path.join(repo, 'src/open.test.ts'), "it('leaves a timer', () => { setInterval(() => {}, 1000); expect(1).toBe(1); });\n");
  try {
    const run = await runner.run(pkg, runner.writeShim(pkg, { root: repo, include: ['src/open.test.ts'] }, path.join(out, 'shims', 'open.shim.mts')), repo, 30_000);
    assert.deepEqual([run.passed, run.timedOut], [1, false]);
    assert.ok(run.durationMs < 20_000, `took ${run.durationMs} ms`);
  } finally {
    rmSync(path.join(repo, 'src/open.test.ts'));
  }
});

test('jest runner: a preset that picks tests by testRegex still runs just the given spec', { timeout: 60_000 }, async () => {
  const runner = new JestRunner();
  writeFileSync(path.join(repo, 'jest-preset.cjs'), "module.exports = { testEnvironment: 'node', testRegex: '\\\\.test\\\\.ts$' };\n");
  writeFileSync(path.join(repo, 'jest.preset-case.config.cjs'), "module.exports = { preset: './jest-preset.cjs' };\n");
  const pkg = { name: 'fixture', dir: repo, testConfig: path.join(repo, 'jest.preset-case.config.cjs') };
  try {
    const run = await runner.run(pkg, runner.writeShim(pkg, { root: repo, include: ['src/price.test.ts'] }, path.join(out, 'shims', 'preset.shim.mts')), repo, 50_000);
    assert.deepEqual([run.passed, run.failed, run.failedFiles], [4, 0, 0], run.output);
  } finally {
    for (const f of ['jest-preset.cjs', 'jest.preset-case.config.cjs']) rmSync(path.join(repo, f));
  }
});
