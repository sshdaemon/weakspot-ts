import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'vitest';
import { remoteRepoName } from '../src/adapters/git/git-change-source.ts';
import { DEFAULTS, loadConfig } from '../src/cli/config.ts';
import { cpus } from 'node:os';

test('loadConfig prefers the remote name, falls back to the folder name, then defaults', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'weakspot-home-'));
  const previous = process.env['WEAKSPOT_HOME'];
  process.env['WEAKSPOT_HOME'] = home;
  try {
    mkdirSync(path.join(home, 'repos'));
    writeFileSync(path.join(home, 'repos', 'remote-name.json'), JSON.stringify({ timeoutMs: 111 }));
    writeFileSync(path.join(home, 'repos', 'folder-name.json'), JSON.stringify({ timeoutMs: 222 }));
    const repoRoot = path.join(home, 'checkouts', 'folder-name');
    assert.equal(loadConfig(repoRoot, 'remote-name').config.timeoutMs, 111);
    assert.equal(loadConfig(repoRoot, undefined).config.timeoutMs, 222);
    assert.equal(loadConfig(repoRoot, 'unknown').config.timeoutMs, 222, 'folder name is tried when the remote has no file');
    const none = loadConfig(path.join(home, 'checkouts', 'other'), undefined);
    assert.equal(none.source, 'defaults');
    assert.equal(none.config.timeoutMs, DEFAULTS.timeoutMs);
  } finally {
    if (previous === undefined) delete process.env['WEAKSPOT_HOME'];
    else process.env['WEAKSPOT_HOME'] = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test('remoteRepoName reads the repository name from the common origin URL forms', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'weakspot-remote-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    for (const [url, expected] of [
      ['git@github.com:sshdaemon/weakspot-ts.git', 'weakspot-ts'],
      ['https://github.com/eequ/eequ-api', 'eequ-api'],
      ['https://github.com/eequ/eequ-api.git/', 'eequ-api'],
      ['ssh://git@host:2222/org/name.git', 'name'],
      ['/Users/x/repos/local-repo', 'local-repo'],
    ] as const) {
      try {
        execFileSync('git', ['remote', 'remove', 'origin'], { cwd: dir, stdio: 'ignore' });
      } catch {
        // no origin yet
      }
      execFileSync('git', ['remote', 'add', 'origin', url], { cwd: dir });
      assert.equal(remoteRepoName(dir), expected, url);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('defaults: concurrency is the core count capped at 8, and the unit lane carries the same limits', () => {
  assert.equal(DEFAULTS.concurrency, Math.max(1, Math.min(8, cpus().length)));
  assert.deepEqual(DEFAULTS.lanes, [{ name: 'unit', specs: ['imports'], envPerWorker: {}, timeoutMs: 3000, concurrency: DEFAULTS.concurrency }]);
});
