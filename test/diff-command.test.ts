import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { ChangeListError, type ChangeList } from '../src/change/change-list.ts';
import { validate } from '../src/cli/config.ts';
import { diffCommand } from '../src/cli/diff-command.ts';
import type { MutationEngine } from '../src/ports/mutation-engine.ts';
import type { ChangeSource } from '../src/ports/change-source.ts';

let repo: string;
let out: string;
beforeEach(() => {
  repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'weakspot-diffcmd-')));
  out = mkdtempSync(path.join(os.tmpdir(), 'weakspot-diffcmd-out-'));
  mkdirSync(path.join(repo, 'src'));
  writeFileSync(path.join(repo, 'src/a.ts'), '');
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

function go(list: ChangeList, verified: unknown[][], ran: string[]) {
  const source: ChangeSource = {
    changes: () => assert.fail('a change list replaces git diff'),
    defaultBase: () => undefined,
    verifyHead: (root, head, paths) => verified.push([root, head, [...paths]]),
  };
  const engine: MutationEngine = { name: 'fake', workerIdVariable: 'W', run: (plan) => (ran.push(plan.pkg.name), Promise.resolve({ pkg: plan.pkg, mutants: [], testCount: 0, durationMs: 0, artifacts: {} })) };
  return diffCommand({
    source,
    base: 'unused',
    scope: 'working',
    changeList: { list, file: 'changes.json' },
    specs: [],
    baseDir: repo,
    repoRoot: repo,
    out,
    config: validate({}, 'test'),
    runner: { name: 'fake', detect: () => true, writeShim: () => '', engineConfig: () => ({}), run: () => Promise.reject(new Error('unused')) },
    engine,
    specFinder: { find: (_r, _p, file) => ({ file, specs: [], how: 'none' }) },
    packages: { repoRoot: () => repo, packageOf: () => undefined },
    log: () => {},
    commandLine: 'test',
    version: 'test',
  });
}

test('diff --changes checks the head against the listed paths, then reports the change as a list', async () => {
  const verified: unknown[][] = [];
  const { report } = await go({ repo, base: 'main', head: 'abc123', files: [{ path: 'src/a.ts', status: 'modified', ranges: [{ start: 1, end: 1 }] }] }, verified, []);
  assert.deepEqual(verified, [[repo, 'abc123', ['src/a.ts']]]);
  assert.deepEqual(report.change, { kind: 'changes', detail: 'main..abc123, from changes.json' });
});

test('diff --changes refuses a list naming a missing file before any engine runs', async () => {
  const ran: string[] = [];
  await assert.rejects(
    () => go({ repo, base: 'main', head: 'working-tree', files: [{ path: 'src/gone.ts', status: 'modified', ranges: 'whole' }] }, [], ran),
    (err: unknown) => err instanceof ChangeListError && /listed files do not exist .*: src\/gone\.ts$/.test(err.message),
  );
  assert.deepEqual(ran, []);
});
