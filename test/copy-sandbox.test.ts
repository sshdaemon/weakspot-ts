import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { CopySandboxFactory } from '../src/adapters/fs/copy-sandbox.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'weakspot-sandbox-'));
  const files = ['pkg/src/a.ts', 'pkg/src/build/b.ts', 'pkg/dist/a.js', 'pkg/coverage/x', 'pkg/.turbo/x', 'pkg/node_modules/dep/index.js', 'pkg/src/node_modules/x.js', 'pkg/vitest.config.ts', 'pkg/.next/cache/x', 'pkg/services/web/.next/x', 'pkg/.nuxt/x', 'pkg/src/.svelte-kit/x', 'pkg/tsconfig.tsbuildinfo', 'pkg/src/.git/x', 'pkg/src/dist/x.ts', 'bare/src/a.ts'];
  for (const f of files) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    writeFileSync(path.join(root, f), f);
  }
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test('copy sandbox: sources copied, build output and caches left out, node_modules linked back; write, restore, dispose', () => {
  const pkg = path.join(root, 'pkg');
  const sandbox = new CopySandboxFactory().create(pkg, path.join(root, 'box'));
  const has = (f: string) => existsSync(path.join(sandbox.dir, f));
  assert.deepEqual(['src/a.ts', 'src/build/b.ts', 'vitest.config.ts'].map(has), [true, true, true]);
  assert.deepEqual(['src/dist/x.ts'].map(has), [true], 'a build folder name deeper down is source');
  const leftOut = ['dist/a.js', 'coverage/x', '.turbo/x', 'src/node_modules/x.js', '.next/cache/x', 'services/web/.next/x', '.nuxt/x', 'src/.svelte-kit/x', 'tsconfig.tsbuildinfo', 'src/.git/x'];
  assert.deepEqual(leftOut.filter(has), []);
  assert.ok(lstatSync(path.join(sandbox.dir, 'node_modules')).isSymbolicLink());
  assert.equal(readlinkSync(path.join(sandbox.dir, 'node_modules')), path.join(pkg, 'node_modules'));
  sandbox.write('src/a.ts', 'mutated');
  assert.deepEqual([readFileSync(path.join(sandbox.dir, 'src/a.ts'), 'utf8'), readFileSync(path.join(pkg, 'src/a.ts'), 'utf8')], ['mutated', 'pkg/src/a.ts']);
  sandbox.restore('src/a.ts');
  assert.equal(readFileSync(path.join(sandbox.dir, 'src/a.ts'), 'utf8'), 'pkg/src/a.ts');
  assert.throws(() => new CopySandboxFactory().create(pkg, sandbox.dir), /already exists/);
  sandbox.dispose();
  assert.ok(!existsSync(sandbox.dir));
  assert.ok(existsSync(path.join(pkg, 'node_modules/dep/index.js')), 'disposing never follows the link');
});

test('copy sandbox: a package without node_modules gets no link', () => {
  const sandbox = new CopySandboxFactory().create(path.join(root, 'bare'), path.join(root, 'box'));
  assert.deepEqual([existsSync(path.join(sandbox.dir, 'src/a.ts')), existsSync(path.join(sandbox.dir, 'node_modules'))], [true, false]);
});
