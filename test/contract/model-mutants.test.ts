import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { main } from '../../src/cli/main.ts';
import type { PlaceholderFile } from '../../src/mutation/model.ts';
import type { Report } from '../../src/report/types.ts';

const fixtures = path.resolve(import.meta.dirname, '../../fixtures');
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

test('propose, then run an author\'s mutants with Vitest in sandboxes, merged into the files run\'s report; a stale answer is rejected', { timeout: 180_000 }, async () => {
  const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'weakspot-model-')));
  const out = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'weakspot-model-out-')));
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'weakspot-model-home-')));
  const previousHome = process.env['WEAKSPOT_HOME'];
  process.env['WEAKSPOT_HOME'] = home;
  try {
    cpSync(path.join(fixtures, 'vitest-basic'), repo, { recursive: true, filter: (src) => !src.endsWith('node_modules') });
    symlinkSync(path.resolve(fixtures, '..', 'node_modules'), path.join(repo, 'node_modules'));
    for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['commit', '-q', '-m', 'base']]) execFileSync('git', args, { cwd: repo, env });
    const price = path.join(repo, 'src/price.ts');

    assert.equal(await main(['files', `${price}:1-5`, '--out', out, '--quiet']), 1);
    assert.equal(await main(['propose', `${price}:1-5`, '--out', out, '--quiet']), 0);
    const placeholders = JSON.parse(readFileSync(path.join(out, 'placeholders.json'), 'utf8')) as PlaceholderFile;
    assert.match(placeholders.instructions, /^# Writing model mutants/);
    const id = (original: string) => placeholders.placeholders.find((p) => p.original === original)!.id;
    writeFileSync(
      path.join(out, 'answers.json'),
      JSON.stringify({
        mutants: [
          { placeholder: id('Math.round'), replacement: 'Math.ceil', because: 'a part penny rounds up' },
          { placeholder: id('Math.round'), replacement: 'Math.floor', because: 'a part penny rounds down, so customers pay less' },
          { placeholder: id('percent >= 100'), replacement: 'percent >=', because: 'broken' },
        ],
      }),
    );
    assert.equal(await main(['run', '--mutants', path.join(out, 'answers.json'), '--quiet']), 1);
    const report = JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8')) as Report;
    const model = report.mutants.filter((m) => m.mutator === 'model');
    assert.deepEqual(model.map((m) => [m.replacement, m.status]), [['Math.ceil', 'Killed'], ['Math.floor', 'Survived']]);
    assert.ok(report.mutants.some((m) => m.mutator !== 'model'), 'the operator mutants of the files run stay');
    assert.deepEqual(report.packages.map((p) => Boolean(p.model)), [false, true]);
    const finding = report.findings.find((f) => f.mutant?.mutator === 'model')!;
    assert.equal(finding.claim, 'No test fails when src/price.ts:4 becomes `Math.floor`: a part penny rounds down, so customers pay less.');
    assert.deepEqual(report.model!.rejected.map((r) => r.reason.split(':')[0]), ['does not parse']);
    assert.equal(readFileSync(price, 'utf8').includes('Math.round('), true, 'the real tree is never edited');

    // Replay: the cached mutants come back marked, and a changed line makes them stale.
    assert.equal(await main(['propose', `${price}:1-5`, '--out', out, '--quiet']), 0);
    const again = JSON.parse(readFileSync(path.join(out, 'placeholders.json'), 'utf8')) as PlaceholderFile;
    assert.deepEqual(again.placeholders.find((p) => p.original === 'Math.round')!.cached!.map((c) => c.replacement), ['Math.ceil', 'Math.floor']);
    writeFileSync(price, readFileSync(price, 'utf8').replace('Math.round(', 'Math.trunc('));
    writeFileSync(path.join(out, 'none.json'), '{ "mutants": [] }');
    assert.equal(await main(['run', '--mutants', path.join(out, 'none.json'), '--quiet']), 1);
    const stale = JSON.parse(readFileSync(path.join(out, 'rejected.json'), 'utf8')) as { rejected: { reason: string }[] };
    assert.deepEqual(stale.rejected.map((r) => r.reason.split(':')[0]), ['the source changed since propose', 'the source changed since propose']);
  } finally {
    if (previousHome === undefined) delete process.env['WEAKSPOT_HOME'];
    else process.env['WEAKSPOT_HOME'] = previousHome;
    for (const dir of [repo, out, home]) rmSync(dir, { recursive: true, force: true });
  }
});
