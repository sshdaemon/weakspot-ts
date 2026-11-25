import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { JsonCoverageMapStore } from '../../src/adapters/fs/coverage-map-store.ts';
import { packagesWithConfig } from '../../src/adapters/fs/package-locator.ts';
import { CoverageSpecFinder } from '../../src/adapters/spec/coverage-spec-finder.ts';
import { VitestRunner } from '../../src/adapters/vitest/vitest-runner.ts';
import { validate } from '../../src/cli/config.ts';
import { main } from '../../src/cli/main.ts';
import { mapCommand } from '../../src/cli/map-command.ts';

const fixtures = path.resolve(import.meta.dirname, '../../fixtures');
const toolModules = path.resolve(fixtures, '..', 'node_modules');
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

/** A copy of a fixture as its own git repository, with the tool's node_modules linked in. */
function copy(name: string): string {
  const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), `weakspot-${name}-`)));
  cpSync(path.join(fixtures, name), repo, { recursive: true, filter: (src) => !src.endsWith('node_modules') });
  symlinkSync(toolModules, path.join(repo, 'node_modules'));
  return repo;
}

function commit(repo: string): string {
  for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['commit', '-q', '-m', 'base']]) execFileSync('git', args, { cwd: repo, env });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
}

test('vitest records the files in which each spec file ran a function, a failing one included, mocked and merely loaded modules left out', { timeout: 120_000 }, async () => {
  const repo = copy('vitest-basic');
  const work = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'weakspot-record-')));
  try {
    // What SWC writes for a decorated class: helpers called at load, then the class; the spec only imports it.
    writeFileSync(path.join(repo, 'src/decorated.ts'), "function _ts_decorate(d: unknown[], t: unknown) { return d.length ? t : t; }\nfunction _ts_metadata(k: string, v: unknown) { return [k, v]; }\nexport class Repo {\n  constructor() {}\n  find(id: number) { return id; }\n}\n_ts_decorate([_ts_metadata('design:type', Object)], Repo);\nexport const repo = new Repo();\n");
    writeFileSync(path.join(repo, 'src/decorated.test.ts'), "import { it } from 'vitest';\nimport { repo } from './decorated';\nit('boots', () => void repo);\n");
    writeFileSync(path.join(repo, 'src/imports-only.test.ts'), "import { it } from 'vitest';\nimport { label } from './price';\nit('only imports', () => void label);\n");
    writeFileSync(path.join(repo, 'src/fails.test.ts'), "import { it, expect } from 'vitest';\nimport { label } from './price';\nit('fails', () => expect(label(150)).toBe('nope'));\n");
    const pkg = { name: 'fixture', dir: repo, testConfig: path.join(repo, 'vitest.config.ts') };
    const { executed, result } = await new VitestRunner().recordCoverage(pkg, { workDir: work, env: {} });
    const ran = (spec: string) => (executed.get(path.join(repo, spec)) ?? []).filter((m) => m.startsWith(`${repo}/src/`)).map((m) => path.relative(repo, m)).toSorted();
    assert.deepEqual(ran('src/price.test.ts'), ['src/price.ts']);
    assert.deepEqual(ran('src/fails.test.ts'), ['src/price.ts']);
    assert.deepEqual(ran('src/imports-only.test.ts'), [], 'loading a module is not running it: a function of it has to run');
    assert.deepEqual(ran('src/decorated.test.ts'), [], 'decorator helpers and a constructor run at load; no method did');
    assert.equal(ran('src/loaded-domock.test.ts').includes('src/loaded.ts'), false, 'a module the spec mocks never ran');
    assert.ok(result.failed >= 1, 'the failing spec is reported as failing');
    assert.throws(() => packagesWithConfig(repo, 'vitest.config.ts'), /is not a git checkout/);
    commit(repo);
    assert.deepEqual(packagesWithConfig(repo, 'vitest.config.ts').map((p) => [p.name, p.dir]), [['fixture-vitest-basic', repo]]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test('map: the e2e lane of every package with its config, per-worker env applied, then read back as that lane\'s specs', { timeout: 180_000 }, async () => {
  const repo = copy('vitest-lanes');
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'weakspot-maps-')));
  try {
    const head = commit(repo);
    const config = validate({ lanes: { e2e: { config: 'vitest-e2e.config.ts', specs: ['coverage', 'imports'], envPerWorker: { FIXTURE_DB: 'db_{worker}' } } } }, 'test');
    const lane = config.lanes[1]!;
    const store = new JsonCoverageMapStore(path.join(home, 'maps'));
    // An origin, so the config is found from a subfolder too and only the top check can refuse there.
    execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/o/lanes-fixture.git'], { cwd: repo });
    mkdirSync(path.join(home, 'repos'), { recursive: true });
    writeFileSync(path.join(home, 'repos', 'lanes-fixture.json'), JSON.stringify({ lanes: { e2e: { config: 'vitest-e2e.config.ts', specs: ['coverage'], envPerWorker: { FIXTURE_DB: 'db_{worker}' } } } }));
    const previousHome = process.env['WEAKSPOT_HOME'];
    process.env['WEAKSPOT_HOME'] = home;
    try {
      assert.equal(await main(['map', 'e2e', '--repo', path.join(repo, 'packages/app'), '--quiet']), 2, 'a map made from below the top would be read by no run');
      assert.equal(existsSync(path.join(home, 'maps')), false, 'nothing was mapped');
      assert.equal(await main(['map', 'e2e', '--repo', repo, '--quiet']), 0);
      const viaCli = new JsonCoverageMapStore(path.join(home, 'maps')).read('lanes-fixture', 'e2e');
      assert.deepEqual([viaCli?.commit, viaCli?.packages], [head, ['packages/app', 'packages/e2e-only']], 'stored under the key a run in this checkout reads, at HEAD');
    } finally {
      if (previousHome === undefined) delete process.env['WEAKSPOT_HOME'];
      else process.env['WEAKSPOT_HOME'] = previousHome;
    }
    const packages = packagesWithConfig(repo, 'vitest-e2e.config.ts');
    assert.deepEqual(packages.map((p) => path.relative(repo, p.dir)), ['packages/app', 'packages/e2e-only']);
    const { map, failing } = await mapCommand({ repoRoot: repo, repoKey: 'lanes', lane, runner: new VitestRunner(), store, patterns: config, packages, head, workDir: path.join(home, 'work'), log: () => {} });
    assert.equal(failing, 0, 'the fixture checks the per-worker env, so a pass shows it arrived');
    assert.deepEqual(map.specs, { 'packages/app/e2e/calc.e2e.ts': ['packages/app/src/calc.ts'], 'packages/e2e-only/e2e/only.e2e.ts': ['packages/e2e-only/src/only.ts'] });
    assert.deepEqual(store.read('lanes', 'e2e'), map);
    const finder = new CoverageSpecFinder(store, 'lanes', 'e2e');
    assert.deepEqual(finder.find(repo, packages[0]!, 'packages/app/src/calc.ts'), { file: 'packages/app/src/calc.ts', specs: ['packages/app/e2e/calc.e2e.ts'], how: 'coverage' });
    assert.deepEqual(finder.warnings(), [], 'a map made at HEAD is current');
    writeFileSync(path.join(repo, 'later.txt'), 'x\n');
    for (const args of [['add', 'later.txt'], ['commit', '-q', '-m', 'later']]) execFileSync('git', args, { cwd: repo, env });
    const later = new CoverageSpecFinder(store, 'lanes', 'e2e');
    later.find(repo, packages[0]!, 'packages/app/src/calc.ts');
    assert.match(later.warnings()[0]!, /^the e2e lane's coverage map was made 1 commit\(s\) ago, 0 day\(s\) old/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
