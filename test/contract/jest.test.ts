import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, test } from 'vitest';
import { main } from '../../src/cli/main.ts';
import type { PlaceholderFile } from '../../src/mutation/model.ts';
import type { Report } from '../../src/report/types.ts';

const fixtures = path.resolve(import.meta.dirname, '../../fixtures');
const toolModules = path.resolve(fixtures, '..', 'node_modules');
let repo: string;
let home: string;
let out: string;

beforeAll(() => {
  repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'weakspot-jest-')));
  home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'weakspot-jest-home-')));
  out = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'weakspot-jest-out-')));
  cpSync(path.join(fixtures, 'jest-basic'), repo, { recursive: true, filter: (src) => !src.endsWith('node_modules') });
  // A folder of links, as a real install is: the engine's sandbox drops a node_modules that is one link.
  mkdirSync(path.join(repo, 'node_modules'));
  for (const entry of readdirSync(toolModules)) symlinkSync(path.join(toolModules, entry), path.join(repo, 'node_modules', entry));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
});
afterAll(() => {
  for (const d of [repo, home, out]) rmSync(d, { recursive: true, force: true });
});

async function cli(...args: string[]): Promise<number> {
  const previous = process.env['WEAKSPOT_HOME'];
  process.env['WEAKSPOT_HOME'] = home;
  try {
    return await main([...args, '--quiet']);
  } finally {
    if (previous === undefined) delete process.env['WEAKSPOT_HOME'];
    else process.env['WEAKSPOT_HOME'] = previous;
  }
}

test('files on a Jest package: Stryker\'s Jest runner with per-test coverage gives the same verdicts as the Vitest fixture', { timeout: 180_000 }, async () => {
  assert.equal(await cli('files', path.join(repo, 'src/price.ts'), '--out', path.join(out, 'files')), 1);
  const report = JSON.parse(readFileSync(path.join(out, 'files', 'report.json'), 'utf8')) as Report;
  assert.deepEqual(report.packages.map((p) => [p.name, p.specs, p.counts]), [['fixture-jest-basic', ['src/price.test.ts'], { Killed: 7, Survived: 9, NoCoverage: 1, Ignored: 4 }]]);
  assert.ok(report.survivors.some((s) => s.mutant.start.line === 9 && s.mutant.coveredBy === 1), 'per-test coverage: one test reaches the label condition');
});

test('model mutants on a Jest package run through the Jest CLI in sandboxes', { timeout: 180_000 }, async () => {
  const dir = path.join(out, 'model');
  const price = path.join(repo, 'src/price.ts');
  assert.equal(await cli('propose', `${price}:1-5`, '--out', dir), 0);
  const placeholders = JSON.parse(readFileSync(path.join(dir, 'placeholders.json'), 'utf8')) as PlaceholderFile;
  const id = placeholders.placeholders.find((p) => p.original === 'Math.round')!.id;
  writeFileSync(
    path.join(dir, 'answers.json'),
    JSON.stringify({
      mutants: [
        { placeholder: id, replacement: 'Math.ceil', because: 'a part penny rounds up' },
        { placeholder: id, replacement: 'Math.floor', because: 'a part penny rounds down' },
      ],
    }),
  );
  assert.equal(await cli('run', '--mutants', path.join(dir, 'answers.json')), 1);
  const report = JSON.parse(readFileSync(path.join(dir, 'report.json'), 'utf8')) as Report;
  assert.deepEqual(report.mutants.map((m) => [m.replacement, m.status]), [['Math.ceil', 'Killed'], ['Math.floor', 'Survived']]);
});
