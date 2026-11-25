import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PullRequest } from '../../src/ports/pull-request-source.ts';

const fixtures = path.resolve(import.meta.dirname, '../../fixtures');
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
export const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim();

/**
 * An origin with `main` and a pull request ref, and a clone of it with installed dependencies: the
 * fixture's project at the root, plus a workspace package linked from node_modules.
 */
export function setUp(): { root: string; main: string; pr: PullRequest } {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'weakspot-pr-')));
  const origin = path.join(root, 'org', 'app.git');
  const work = path.join(root, 'work');
  cpSync(path.join(fixtures, 'vitest-basic'), work, { recursive: true, filter: (src) => !src.endsWith('node_modules') });
  mkdirSync(path.join(work, 'packages/shared'), { recursive: true });
  writeFileSync(path.join(work, 'packages/shared/package.json'), '{ "name": "@app/shared" }\n');
  writeFileSync(path.join(work, 'packages/shared/index.js'), 'export const v = 1;\n');
  mkdirSync(path.join(work, 'packages/other'), { recursive: true });
  writeFileSync(path.join(work, 'packages/other/package.json'), '{ "name": "@app/other" }\n');
  writeFileSync(path.join(work, 'package-lock.json'), '{ "lockfileVersion": 3 }\n');
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'base');
  const base = git(work, 'rev-parse', 'HEAD');
  git(work, 'checkout', '-q', '-b', 'feature');
  writeFileSync(path.join(work, 'src/price.ts'), readFileSync(path.join(work, 'src/price.ts'), 'utf8').replace('Math.round(', 'Math.round(0 + '));
  git(work, 'commit', '-qam', 'change');
  const head = git(work, 'rev-parse', 'HEAD');
  mkdirSync(path.dirname(origin), { recursive: true });
  git(root, 'clone', '-q', '--bare', work, origin);
  git(origin, 'update-ref', 'refs/pull/7/head', head);
  git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(origin, 'branch', '-q', '-D', 'feature');
  const main = path.join(root, 'main');
  git(root, 'clone', '-q', origin, main);
  // The install: the tool's own dependencies, a scope folder, and a workspace link into the checkout.
  const modules = path.join(main, 'node_modules');
  mkdirSync(path.join(modules, '@app'), { recursive: true });
  const toolModules = path.resolve(fixtures, '..', 'node_modules');
  for (const dep of ['vitest', '.bin']) symlinkSync(path.join(toolModules, dep), path.join(modules, dep));
  symlinkSync('../../packages/shared', path.join(modules, '@app/shared'));
  symlinkSync('../../packages/removed', path.join(modules, '@app/removed'));
  // A `link:` or `file:` dependency on a folder beside the checkout, with no node_modules in its path.
  mkdirSync(path.join(root, 'sibling-lib'));
  symlinkSync('../../sibling-lib', path.join(modules, 'sibling-lib'));
  mkdirSync(path.join(modules, '.pnpm/dep@1/node_modules'), { recursive: true });
  // A package's own install: an external dependency and a workspace link to its sibling.
  const shared = path.join(main, 'packages/shared/node_modules');
  mkdirSync(path.join(shared, '@app'), { recursive: true });
  symlinkSync(path.join(toolModules, 'vitest'), path.join(shared, 'vitest'));
  symlinkSync('../../../other', path.join(shared, '@app/other'));
  const pr: PullRequest = { number: 7, url: 'https://github.com/org/app/pull/7', repo: 'org/app', headSha: head, baseRef: 'main', baseSha: base };
  return { root, main, pr };
}

