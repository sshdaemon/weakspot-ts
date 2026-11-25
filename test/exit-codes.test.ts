import assert from 'node:assert/strict';
import { test } from 'vitest';
import { SuppressionStoreError } from '../src/adapters/fs/suppression-store.ts';
import { GitError } from '../src/adapters/git/git-change-source.ts';
import { SpecCommandError } from '../src/adapters/shell/command-spec-finder.ts';
import { PrepareError } from '../src/adapters/shell/run-command.ts';
import { EngineFailedError } from '../src/adapters/stryker/stryker-engine.ts';
import { SandboxNotLoadedError, TestsFailBeforeMutationError } from '../src/mutation/errors.ts';
import { ChangeListError } from '../src/change/change-list.ts';
import { MutantsFileError } from '../src/mutation/validate.ts';
import { ConfigError } from '../src/cli/config.ts';
import { EXIT, exitCodeFor, exitCodeOf, messageFor } from '../src/cli/exit-codes.ts';
import { main } from '../src/cli/main.ts';
import { InterruptedError, UninstrumentedError, UsageError } from '../src/cli/pipeline.ts';

test('exit codes: 2 for what the caller got wrong, 3 for a run that could not complete, 130 when interrupted', () => {
  assert.deepEqual(EXIT, { clean: 0, findings: 1, usage: 2, failed: 3, interrupted: 130 });
  for (const err of [new UsageError('u'), new ConfigError('c'), new GitError('g'), new SuppressionStoreError('s'), new ChangeListError('l'), new MutantsFileError('m')]) assert.equal(exitCodeFor(err), 2, err.name);
  for (const err of [new TestsFailBeforeMutationError('p', 'd'), new PrepareError('p'), new SpecCommandError('s'), new EngineFailedError('e'), new UninstrumentedError(['a.ts'], []), new SandboxNotLoadedError(['a.ts']), new Error('a bug'), 'a string']) {
    assert.equal(exitCodeFor(err), 3, String(err));
  }
  assert.equal(exitCodeFor(new InterruptedError()), 130);
});

test('messages: known errors print their message, anything else is marked as a weakspot failure with its stack', () => {
  assert.equal(messageFor(new UsageError('bad flag')), 'bad flag');
  assert.equal(messageFor(new PrepareError('prepare exited with 1')), 'prepare exited with 1');
  assert.equal(messageFor(new EngineFailedError('stryker exited with 1')), 'stryker exited with 1', 'an engine failure is expected, not a bug');
  assert.match(messageFor(new UninstrumentedError(['a.ts'], [])), /^the specs never loaded the instrumented copy of: a\.ts\./);
  assert.equal(messageFor(new ChangeListError('c.json: bad')), 'c.json: bad');
  assert.equal(messageFor(new InterruptedError()), 'interrupted, engine runs stopped');
  assert.match(messageFor(new TypeError('x is undefined')), /^weakspot failed: x is undefined\n\s+at /);
  assert.equal(messageFor(42), 'weakspot failed: 42');
});

test('main never throws: a usage error is printed and exits 2', async () => {
  const writes: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.equal(await main(['mutate']), 2);
    assert.equal(await main(['files']), 2);
    assert.equal(await main(['diff', '--nope']), 2, 'an unknown flag is a usage error');
    assert.equal(await main(['diff', '--changes']), 2, 'a flag without its value is a usage error');
    assert.equal(await main(['files', 'src/cli/main.ts:40-10', '--repo', process.cwd()]), 2, 'a reversed range is a usage error');
  } finally {
    process.stderr.write = original;
  }
  assert.match(writes.join(''), /unknown command mutate/);
  assert.match(writes.join(''), /files: give at least one path/);
  assert.match(writes.join(''), /Unknown option '--nope'[\s\S]*weakspot <command> \[options\]/);
  assert.match(writes.join(''), /src\/cli\/main\.ts:40-10: invalid line range 40-10/);
  assert.doesNotMatch(writes.join(''), /weakspot failed|\n\s+at /);
});

test('a completed run exits 1 with findings and 0 without', () => {
  assert.equal(exitCodeOf({ findings: [] }), EXIT.clean);
  assert.equal(exitCodeOf({ findings: [{ id: 'a.ts#untested' } as never] }), EXIT.findings);
});
