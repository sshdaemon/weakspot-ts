import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, test } from 'vitest';
import { VitestRunner } from '../../src/adapters/vitest/vitest-runner.ts';

const fixtures = path.resolve(import.meta.dirname, '../../fixtures');
let dir: string;
let work: string;
const runner = new VitestRunner();
const pkg = () => ({ name: 'fixture', dir, testConfig: path.join(dir, 'vitest.config.ts') });

beforeAll(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'weakspot-runner-')));
  work = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'weakspot-runner-work-')));
  cpSync(path.join(fixtures, 'vitest-basic'), dir, { recursive: true, filter: (src) => !src.endsWith('node_modules') });
  symlinkSync(path.resolve(fixtures, '..', 'node_modules'), path.join(dir, 'node_modules'));
  writeFileSync(path.join(dir, 'src/broken.test.ts'), "import './missing-module';\nimport { it } from 'vitest';\nit('never runs', () => {});\n");
  writeFileSync(path.join(dir, 'src/slow.test.ts'), "import { it } from 'vitest';\nit('waits', () => new Promise((r) => setTimeout(r, 60_000)), 120_000);\n");
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

const shim = (name: string, include: string[]) => runner.writeShim(pkg(), { root: 'cwd', include }, path.join(work, `${name}.shim.mts`));

test('vitest runner: a spec file that fails to load counts as a failed file even when another file passes', { timeout: 60_000 }, async () => {
  const result = await runner.run(pkg(), shim('mixed', ['src/price.test.ts', 'src/broken.test.ts']), dir, 50_000);
  assert.deepEqual([result.passed > 0, result.failed, result.failedFiles, result.timedOut], [true, 0, 1, false]);
  const green = await runner.run(pkg(), shim('green', ['src/price.test.ts']), dir, 50_000);
  assert.deepEqual([green.passed > 0, green.failed, green.failedFiles], [true, 0, 0]);
});

test('vitest runner: aborting the signal stops the run long before its time limit', { timeout: 60_000 }, async () => {
  const controller = new AbortController();
  const started = Date.now();
  const pending = runner.run(pkg(), shim('slow', ['src/slow.test.ts']), dir, 50_000, { signal: controller.signal });
  setTimeout(() => controller.abort(), 1500);
  const result = await pending;
  assert.ok(Date.now() - started < 20_000, `took ${Date.now() - started}ms`);
  assert.deepEqual([result.passed, result.timedOut], [0, false]);
});

test('vitest runner: an error left unhandled after every test passed counts as a failed file', { timeout: 60_000 }, async () => {
  writeFileSync(path.join(dir, 'src/leak.test.ts'), "import { it } from 'vitest';\nit('passes', () => {\n  setTimeout(() => {\n    throw new Error('late');\n  }, 0);\n});\nit('waits', () => new Promise((r) => setTimeout(r, 50)));\n");
  const result = await runner.run(pkg(), shim('leak', ['src/leak.test.ts']), dir, 50_000);
  assert.deepEqual([result.passed, result.failed, result.failedFiles, result.timedOut], [2, 0, 1, false]);
});
