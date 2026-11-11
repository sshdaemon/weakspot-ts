import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MapSpecFinder } from '../src/adapters/fs/map-spec-finder.ts';
import { CommandSpecFinder, SpecCommandError } from '../src/adapters/shell/command-spec-finder.ts';
import type { Package } from '../src/change/types.ts';
import { FirstSpecFinder } from '../src/adapters/spec/first-spec-finder.ts';

function repo(): { root: string; api: Package; dispose: () => void } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'weakspot-finders-'));
  for (const f of [
    'apps/api/test/suites/schedule/a.e2e-spec.ts',
    'apps/api/test/suites/schedule/b.e2e-spec.ts',
    'apps/api/test/suites/other/c.e2e-spec.ts',
    'apps/api/test/suites/[id]/d.e2e-spec.ts',
    'apps/api/test/suites/i/e.e2e-spec.ts',
    'apps/web/test/schedule/w.e2e-spec.ts',
  ]) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    writeFileSync(path.join(root, f), '');
  }
  const api: Package = { dir: path.join(root, 'apps/api'), name: 'api', testConfig: path.join(root, 'apps/api/vitest-e2e.config.mts') };
  return { root, api, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test('map finder: the first matching regex fills its glob; only existing specs inside the package count', () => {
  const r = repo();
  try {
    const finder = new MapSpecFinder([
      ['^apps/(\\w+)/src/([^/]+)/', 'apps/$1/test/suites/$2/**/*.e2e-spec.ts'],
      ['^apps/(\\w+)/', 'apps/web/test/**/*.e2e-spec.ts'],
    ]);
    const hit = finder.find(r.root, r.api, 'apps/api/src/schedule/x.ts');
    assert.deepEqual(hit.specs, ['apps/api/test/suites/schedule/a.e2e-spec.ts', 'apps/api/test/suites/schedule/b.e2e-spec.ts']);
    assert.equal(hit.how, 'map');
    const miss = finder.find(r.root, r.api, 'apps/api/src/nowhere/y.ts');
    assert.deepEqual(miss, { file: 'apps/api/src/nowhere/y.ts', specs: [], how: 'none' }, 'a matching regex with no files is none, not the next pair');
    const outside = finder.find(r.root, r.api, 'apps/api/lib/z.ts');
    assert.deepEqual(outside.specs, [], 'the second pair points at another package, which does not count');
    assert.deepEqual(finder.find(r.root, r.api, 'tools/t.ts').specs, []);
    const bracket = finder.find(r.root, r.api, 'apps/api/src/[id]/page.ts');
    assert.deepEqual(bracket.specs, ['apps/api/test/suites/[id]/d.e2e-spec.ts'], 'a captured [id] segment is literal, not a bracket class');
  } finally {
    r.dispose();
  }
});

test('command finder: {file} is substituted and quoted, output lines are filtered, a failure is an error', () => {
  const r = repo();
  try {
    const script = path.join(r.root, 'specs-for.sh');
    writeFileSync(script, '#!/bin/sh\ncase "$1" in\n  *schedule*) printf "apps/api/test/suites/schedule/a.e2e-spec.ts\\n\\nmissing.ts\\napps/web/test/schedule/w.e2e-spec.ts\\n";;\n  *boom*) echo "no mapping" >&2; exit 3;;\nesac\n');
    const explicit = new CommandSpecFinder(`sh ${script} {file}`);
    const hit = explicit.find(r.root, r.api, "apps/api/src/schedule/it's.ts");
    assert.deepEqual(hit.specs, ['apps/api/test/suites/schedule/a.e2e-spec.ts'], 'missing files and files outside the package drop out');
    assert.equal(hit.how, 'command');
    const appended = new CommandSpecFinder(`sh ${script}`);
    assert.deepEqual(appended.find(r.root, r.api, 'apps/api/src/schedule/x.ts').specs, ['apps/api/test/suites/schedule/a.e2e-spec.ts']);
    assert.deepEqual(appended.find(r.root, r.api, 'apps/api/src/other.ts'), { file: 'apps/api/src/other.ts', specs: [], how: 'none' });
    assert.throws(() => appended.find(r.root, r.api, 'apps/api/src/boom.ts'), (err: unknown) => err instanceof SpecCommandError && /exited with 3 .*boom.*\nno mapping/s.test(err.message));
  } finally {
    r.dispose();
  }
});

test('first finder: the first source with specs answers', () => {
  const none = { find: () => ({ file: 'f', specs: [], how: 'none' as const }) };
  const some = { find: () => ({ file: 'f', specs: ['s.ts'], how: 'map' as const }) };
  const pkg: Package = { dir: '/r/p', name: 'p', testConfig: '/r/p/vitest.config.ts' };
  assert.deepEqual(new FirstSpecFinder([none, some]).find('/r', pkg, 'f', []), { file: 'f', specs: ['s.ts'], how: 'map' });
  assert.deepEqual(new FirstSpecFinder([none]).find('/r', pkg, 'f', []), { file: 'f', specs: [], how: 'none' });
});
