import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { PrepareError, runPrepare } from '../src/adapters/shell/run-command.ts';

test('runPrepare returns stdout, runs in the given dir, and fails with the exit code and the last ten lines of stderr', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'weakspot-prepare-'));
  try {
    assert.equal(runPrepare('echo ok', dir), 'ok\n');
    assert.equal(runPrepare('pwd', dir).trim(), path.resolve(dir).replace(/^\/var\//, '/private/var/'));
    assert.throws(() => runPrepare('echo boom >&2; exit 3', dir), (err: unknown) => err instanceof PrepareError && /exited with 3 in .*: echo boom >&2; exit 3\nboom$/s.test(err.message));
    assert.throws(
      () => runPrepare('for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo line$i >&2; done; exit 1', dir),
      (err: unknown) => err instanceof PrepareError && !/line2\n/.test(err.message) && /line3\n[\s\S]*line12$/.test(err.message),
    );
    assert.throws(() => runPrepare('true', path.join(dir, 'missing')), PrepareError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
