import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { JsonCoverageMapStore } from '../src/adapters/fs/coverage-map-store.ts';
import { CoverageSpecFinder, type HeadInfo } from '../src/adapters/spec/coverage-spec-finder.ts';
import { FirstSpecFinder } from '../src/adapters/spec/first-spec-finder.ts';
import { coveringSpecs, mapEntries, packageOfPath, staleness, type CoverageMap } from '../src/change/coverage-map.ts';
import type { Package } from '../src/change/types.ts';
import type { CoverageMapStore } from '../src/ports/coverage-map-store.ts';
import { ranFunction } from '../src/adapters/vitest/map-provider.ts';

let repo: string;
beforeEach(() => {
  repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'weakspot-map-')));
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

const map = (over: Partial<CoverageMap> = {}): CoverageMap => ({
  schemaVersion: 1,
  repo: 'org/app',
  lane: 'e2e',
  commit: 'c'.repeat(40),
  createdAt: '2026-11-20T00:00:00.000Z',
  packages: ['.', 'services/api', 'services/api/sub', 'packages/db'],
  specs: {
    'services/api/test/a.e2e.ts': ['services/api/src/a.ts', 'services/api/src/shared.ts', 'packages/db/src/x.ts'],
    'services/api/test/b.e2e.ts': ['services/api/src/shared.ts'],
    'services/api/sub/test/c.e2e.ts': ['services/api/src/a.ts'],
    'packages/db/test/x.e2e.ts': ['packages/db/src/y.ts'],
    'tools/root.e2e.ts': ['packages/db/src/x.ts'],
  },
  ...over,
});

test('mapEntries: repo-relative, only the repo\'s own sources, no node_modules, no specs, none from outside', () => {
  const executed = new Map([
    [`${repo}/services/api/test/a.e2e.ts`, [`${repo}/services/api/src/b.ts`, `${repo}/services/api/src/a.ts`, `${repo}/services/api/src/a.ts`, `${repo}/services/api/test/a.e2e.ts`, `${repo}/node_modules/x/index.js`, `${repo}/services/api/node_modules/y.js`, '/elsewhere/z.ts', 'node:fs', 'virtual:thing']],
    ['/elsewhere/spec.e2e.ts', [`${repo}/services/api/src/a.ts`]],
  ]);
  assert.deepEqual(mapEntries(executed, repo, (rel) => rel.endsWith('.e2e.ts')), { 'services/api/test/a.e2e.ts': ['services/api/src/a.ts', 'services/api/src/b.ts'] });
});

test('packageOfPath: the longest listed package that holds the path; the root holds everything else', () => {
  const pkgs = ['.', 'services/api', 'services/api/sub', 'services/apiary'];
  assert.deepEqual(['services/api/sub/x.ts', 'services/api/x.ts', 'services/apiary/x.ts', 'tools/x.ts', 'services/api'].map((p) => packageOfPath(pkgs, p)), ['services/api/sub', 'services/api', 'services/apiary', '.', 'services/api']);
  assert.equal(packageOfPath(['services/api'], 'tools/x.ts'), undefined);
});

test('coveringSpecs: the package\'s own specs that ran the file, and the other packages that run its package\'s code', () => {
  assert.deepEqual(coveringSpecs(map(), 'services/api/src/a.ts', 'services/api'), { inPackage: ['services/api/test/a.e2e.ts'], fromPackages: ['services/api/sub'] });
  assert.deepEqual(coveringSpecs(map(), 'services/api/src/shared.ts', 'services/api'), { inPackage: ['services/api/test/a.e2e.ts', 'services/api/test/b.e2e.ts'], fromPackages: ['services/api/sub'] });
  assert.deepEqual(coveringSpecs(map(), 'packages/db/src/x.ts', 'packages/db'), { inPackage: [], fromPackages: ['.', 'services/api'] }, 'its own spec ran y.ts, not x.ts');
  assert.deepEqual(coveringSpecs(map(), 'tools/z.ts', '.'), { inPackage: [], fromPackages: [] }, 'code of nested packages is theirs, not the root\'s');
  assert.deepEqual(coveringSpecs(map({ packages: ['services/api'] }), 'packages/db/src/x.ts', 'packages/db'), { inPackage: [], fromPackages: ['services/api'] }, 'a package with no lane config of its own, run through another');
});

test('staleness: nothing at HEAD; otherwise commits behind (or not an ancestor) and days', () => {
  const now = new Date('2026-11-25T12:00:00.000Z');
  assert.equal(staleness(map(), 'c'.repeat(40), 0, now), undefined);
  assert.equal(staleness(map(), 'd'.repeat(40), 7, now), "the e2e lane's coverage map was made 7 commit(s) ago, 5 day(s) old; files added or moved since fall back to the next spec source; weakspot map e2e refreshes it");
  assert.match(staleness(map(), 'd'.repeat(40), undefined, now)!, /^the e2e lane's coverage map was made at cccccccccccc, not an ancestor of HEAD, 5 day\(s\) old;/);
});

test('map store: written and read back per repository and lane; a broken file or another schema reads as none', () => {
  const store = new JsonCoverageMapStore(repo);
  const file = store.write(map({ repo: 'org/app' }));
  assert.equal(file, path.join(repo, 'org_app', 'e2e.json'));
  assert.deepEqual(store.read('org/app', 'e2e'), map({ repo: 'org/app' }));
  assert.equal(store.read('org/app', 'unit'), undefined);
  writeFileSync(file, JSON.stringify({ ...map(), schemaVersion: 2 }));
  assert.equal(store.read('org/app', 'e2e'), undefined);
  for (const bad of [{ ...map(), specs: null }, { ...map(), specs: 'x' }, { ...map(), specs: ['a'] }, { ...map(), specs: { a: 'b' } }, { ...map(), packages: 'x' }, { ...map(), commit: 1 }, { ...map(), createdAt: 'yesterday' }, { ...map(), missing: 'services/web' }]) {
    writeFileSync(file, JSON.stringify(bad));
    assert.equal(store.read('org/app', 'e2e'), undefined);
  }
  writeFileSync(file, '{ broken');
  assert.equal(store.read('org/app', 'e2e'), undefined);
});

/** A store that counts reads; HEAD and its distance from the map's commit are given. */
function finder(stored: CoverageMap | undefined, head = 'c'.repeat(40), behind: number | undefined = 3) {
  let reads = 0;
  const store: CoverageMapStore = {
    read: () => {
      reads++;
      return stored;
    },
    write: () => '',
  };
  const git: HeadInfo = { head: () => head, commitsSince: () => behind };
  return { f: new CoverageSpecFinder(store, 'org/app', 'e2e', git, () => new Date('2026-11-25T00:00:00.000Z')), reads: () => reads };
}

const api: Package = { dir: '', name: 'api', testConfig: '' };
const pkg = (dir: string): Package => ({ ...api, dir: path.join(repo, dir) });

test('coverage finder: the file\'s own package\'s specs that still exist, from a map read once', () => {
  for (const spec of ['services/api/test/a.e2e.ts']) {
    mkdirSync(path.dirname(path.join(repo, spec)), { recursive: true });
    writeFileSync(path.join(repo, spec), '');
  }
  const { f, reads } = finder(map());
  assert.deepEqual(f.find(repo, pkg('services/api'), 'services/api/src/shared.ts'), { file: 'services/api/src/shared.ts', specs: ['services/api/test/a.e2e.ts'], how: 'coverage' }, 'b.e2e.ts was deleted since');
  assert.deepEqual(f.find(repo, pkg('services/api'), 'services/api/src/new.ts'), { file: 'services/api/src/new.ts', specs: [], how: 'none' });
  assert.deepEqual(f.find(repo, pkg('packages/db'), 'packages/db/src/x.ts').specs, []);
  assert.equal(reads(), 1);
  assert.deepEqual(f.warnings(), [], 'a map made at HEAD');
});

test('coverage finder: explains coverage from other packages, warns about a stale or missing map', () => {
  const stale = finder(map(), 'd'.repeat(40), 3).f;
  assert.equal(stale.explain(repo, 'packages/db/src/x.ts', 'packages/db'), "the e2e lane's coverage map shows specs in ., services/api running code of packages/db, but mutants run against the specs of their own package");
  assert.match(stale.explain(repo, 'services/api/src/new.ts', 'services/api')!, /specs in services\/api\/sub running code of services\/api/, 'a file the map has never seen, in a package others run');
  assert.equal(finder(map({ specs: {} })).f.explain(repo, 'packages/db/src/x.ts', 'packages/db'), undefined);
  assert.match(finder(map({ packages: ['services/api'] })).f.explain(repo, 'packages/db/src/x.ts', 'packages/db')!, /specs in services\/api running code of packages\/db/, 'a package without the lane config, located from its package.json');
  assert.match(stale.warnings()[0]!, /^the e2e lane's coverage map was made 3 commit\(s\) ago, 5 day\(s\) old/);
  const missing = finder(undefined).f;
  assert.deepEqual([missing.find(repo, pkg('services/api'), 'services/api/src/a.ts').specs, missing.explain(repo, 'services/api/src/a.ts', 'services/api')], [[], undefined]);
  assert.deepEqual(missing.warnings(), ['the e2e lane lists coverage as a spec source but has no coverage map yet; weakspot map e2e makes one']);
  assert.deepEqual(finder(map()).f.warnings(), [], 'nothing is said before the map was needed');
  const gappy = finder(map({ missing: ['services/web'] })).f;
  assert.equal(gappy.explain(repo, 'services/web/src/a.ts', 'services/web'), "the e2e lane's coverage map has no record of services/web: its suite recorded nothing when the map was made");
  assert.deepEqual(gappy.warnings(), ["the e2e lane's coverage map has no record of services/web, whose suites recorded nothing; weakspot map e2e tries again"]);
});

test('a chain of spec sources passes on the first explanation and every warning', () => {
  const quiet = { find: () => ({ file: 'f', specs: [], how: 'none' as const }) };
  const talking = { ...quiet, explain: () => 'second', warnings: () => ['w2'] };
  const chain = new FirstSpecFinder([quiet, { ...quiet, explain: () => undefined, warnings: () => ['w1'] }, talking, { ...quiet, explain: () => 'fourth' }]);
  assert.deepEqual([chain.explain(repo, 'f', '.'), chain.warnings()], ['second', ['w1', 'w2']]);
});

const fn = (functionName: string, count: number) => ({ functionName, ranges: [{ count }] });

test('ranFunction: a named function other than a constructor ran; in .tsx a capitalised one is a component', () => {
  const loadedOnly = [fn('', 1), fn('', 1), fn('<instance_members_initializer>', 1), fn('Service', 1), fn('used', 0)];
  assert.equal(ranFunction('a.ts', loadedOnly), false, 'module body, export getter, field initializer and constructor do not count');
  assert.equal(ranFunction('a.ts', [...loadedOnly, fn('used', 2)]), true);
  assert.equal(ranFunction('a.tsx', [fn('Button', 1)]), true);
  assert.equal(ranFunction('a.jsx', [fn('Button', 1)]), true);
  assert.equal(ranFunction('a.ts', [fn('Button', 1)]), false);
  assert.equal(ranFunction('a.ts', [{ functionName: 'x', ranges: [] }]), false);
  for (const helper of ['_ts_decorate', '_ts_metadata', '__decorateClass', '__publicField', '_define_property']) assert.equal(ranFunction('a.ts', [fn(helper, 3)]), false, helper);
  assert.equal(ranFunction('a.ts', [fn('getUser', 1)]), true, 'a camelCase method');
  assert.equal(ranFunction('a.ts', [fn('getUserById', 1), fn('Service', 1)]), true);
});
