import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { GhPullRequestSource, PullRequestError, pullRequestOf } from '../src/adapters/gh/gh-pull-request-source.ts';
import { changedLockfiles } from '../src/change/lockfiles.ts';
import type { ChangedFile } from '../src/change/types.ts';
import { exitCodeFor } from '../src/cli/exit-codes.ts';
import { UsageError, type PipelineInput } from '../src/cli/pipeline.ts';
import { cleanWorktrees, MARKER, prCommand, processStart, type PrCommandInput } from '../src/cli/pr-command.ts';
import type { PullRequest, PullRequestCheckout } from '../src/ports/pull-request-source.ts';
import { emptyReport } from '../src/report/merge.ts';

let trees: string;
beforeEach(() => {
  trees = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'weakspot-pr-trees-')));
});
afterEach(() => rmSync(trees, { recursive: true, force: true }));

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const ghJson = { number: 12, url: 'https://github.com/org/app/pull/12', headRefOid: HEAD, baseRefName: 'develop', baseRefOid: BASE };

test('changedLockfiles: every package manager\'s lockfile, at any depth, by exact name', () => {
  assert.deepEqual(changedLockfiles(['pnpm-lock.yaml', 'services/web/package-lock.json', 'yarn.lock', 'npm-shrinkwrap.json', 'bun.lock', 'x/bun.lockb', 'package.json', 'src/yarn.lock.ts', 'my-pnpm-lock.yaml']), [
    'pnpm-lock.yaml',
    'services/web/package-lock.json',
    'yarn.lock',
    'npm-shrinkwrap.json',
    'bun.lock',
    'x/bun.lockb',
  ]);
});

test('pullRequestOf: the repository comes from the URL; anything missing or malformed is a pull request error', () => {
  assert.deepEqual(pullRequestOf(ghJson, '12'), { number: 12, url: ghJson.url, repo: 'org/app', headSha: HEAD, baseRef: 'develop', baseSha: BASE });
  const broken = [null, 'x', { ...ghJson, url: 'https://github.com/org/app/issues/12' }, { ...ghJson, number: '12' }, { ...ghJson, headRefOid: 'abc' }, { ...ghJson, baseRefOid: undefined }, { ...ghJson, baseRefName: '' }];
  for (const raw of broken) assert.throws(() => pullRequestOf(raw, '12'), (e: unknown) => e instanceof PullRequestError && exitCodeFor(e) === 2 && /unexpected answer for pull request 12/.test(e.message));
});

const failing = (err: object) =>
  new GhPullRequestSource(() => {
    throw Object.assign(new Error('boom'), err);
  });

test('gh source: asks gh in the checkout, and names a missing gh, a failed call and a non-JSON answer', () => {
  const calls: [readonly string[], string][] = [];
  const ok = new GhPullRequestSource((args, cwd) => {
    calls.push([args, cwd]);
    return JSON.stringify(ghJson);
  });
  assert.equal(ok.describe('/repo', 'https://github.com/org/app/pull/12').repo, 'org/app');
  assert.deepEqual(calls, [[['pr', 'view', 'https://github.com/org/app/pull/12', '--json', 'number,url,headRefOid,baseRefName,baseRefOid'], '/repo']]);
  assert.throws(() => failing({ code: 'ENOENT' }).describe('/r', '1'), /gh is not installed/);
  assert.throws(() => failing({ stderr: 'GraphQL: Could not resolve\nmore' }).describe('/r', '1'), /^PullRequestError: gh could not read pull request 1: GraphQL: Could not resolve$/m);
  assert.throws(() => new GhPullRequestSource(() => 'not json').describe('/r', '1'), /unexpected answer/);
});

/** A checkout that records what it is asked; `reuse` says whether a worktree is already there. */
function fakeCheckout(opts: { origin?: string | undefined; drift?: string[]; reuse?: boolean; kept?: string[]; files?: string[] } = {}) {
  const events: string[] = [];
  const checkout: PullRequestCheckout = {
    originRepo: () => ('origin' in opts ? opts.origin : 'Org/App'),
    checkTop: (root) => events.push(`top ${root}`),
    fetch: (_root, pr) => events.push(`fetch ${pr.number}`),
    lockfileDrift: (_root, sha) => {
      events.push(`drift ${sha.slice(0, 4)}`);
      return opts.drift ?? [];
    },
    add: (_root, dir, sha) => {
      events.push(`add ${path.basename(dir)} ${sha.slice(0, 4)}`);
      mkdirSync(dir, { recursive: true });
      for (const f of opts.files ?? []) {
        mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
        writeFileSync(path.join(dir, f), '');
      }
      return opts.reuse ?? false;
    },
    remove: (_root, dir) => {
      events.push(`remove ${path.basename(dir)}`);
      rmSync(dir, { recursive: true, force: true });
    },
    list: () => opts.kept ?? [],
  };
  return { checkout, events };
}

function prInput(checkout: PullRequestCheckout, over: Partial<PrCommandInput> = {}) {
  const seen: PipelineInput[] = [];
  const linked: string[] = [];
  const changes: ChangedFile[] = [{ path: 'src/a.ts', status: 'modified', ranges: [{ start: 1, end: 2 }] }];
  const queries: string[] = [];
  const input = {
    mainRoot: '/main',
    baseDir: '/main',
    ref: '12',
    keep: false,
    worktrees: trees,
    pid: 4242,
    startOf: (pid: number) => (pid === 4242 ? 'started 4242' : undefined),
    specs: [],
    prs: { describe: (): PullRequest => pullRequestOf(ghJson, '12') },
    checkout,
    linker: {
      link: (main: string, tree: string) => {
        linked.push(`${main} -> ${tree}`);
        return ['.'];
      },
    },
    source: {
      changes: (q: { repoRoot: string; base: string; scope: string }) => {
        queries.push(`${q.repoRoot} ${q.base.slice(0, 4)} ${q.scope}`);
        return changes;
      },
      defaultBase: () => undefined,
      verifyHead: () => {},
    },
    run: (p: PipelineInput) => {
      seen.push(p);
      return Promise.resolve({ report: emptyReport({ version: 't', repo: p.repoRoot, command: 'c', change: p.change }), outDir: '/out' });
    },
    out: '/out',
    log: () => {},
    commandLine: 'weakspot pr 12',
    version: 't',
    ...over,
  } as unknown as PrCommandInput;
  return { input, seen, linked, queries };
}

test('pr: fetch, a worktree at the head, dependencies linked, the pipeline run there on the committed diff against the base commit, then removed', async () => {
  const { checkout, events } = fakeCheckout();
  const { input, seen, linked, queries } = prInput(checkout);
  const done = await prCommand(input);
  const dir = path.join(trees, 'pr-12-aaaaaaaaaaaa-4242');
  assert.deepEqual(events, ['top /main', 'fetch 12', 'drift aaaa', 'add pr-12-aaaaaaaaaaaa-4242 aaaa', 'remove pr-12-aaaaaaaaaaaa-4242']);
  assert.deepEqual([linked, queries], [[`/main -> ${dir}`], [`${dir} bbbb committed`]]);
  assert.deepEqual([seen[0]!.repoRoot, seen[0]!.change], [dir, { kind: 'pr', detail: `${ghJson.url} at aaaaaaaaaaaa, against develop` }]);
  assert.deepEqual([done.worktree, done.pr.number], [dir, 12]);
});

const readMarker = (dir: string) => JSON.parse(readFileSync(path.join(dir, MARKER), 'utf8')) as { pid: number; kept: boolean };
const keptDir = () => path.join(trees, 'pr-12-aaaaaaaaaaaa');

test('pr --keep works in the kept folder and marks it kept when done; the next --keep run reuses it without linking', async () => {
  const first = fakeCheckout();
  const one = prInput(first.checkout, { keep: true });
  const done = await prCommand(one.input);
  assert.deepEqual([done.worktree, readMarker(keptDir()), first.events.includes('remove pr-12-aaaaaaaaaaaa')], [keptDir(), { pid: 4242, started: 'started 4242', kept: true }, false]);
  const again = fakeCheckout({ reuse: true });
  const two = prInput(again.checkout, { keep: true, pid: 5151, startOf: (pid) => `started ${pid}` });
  await prCommand(two.input);
  assert.deepEqual([again.events, two.linked], [['top /main', 'fetch 12', 'drift aaaa', 'add pr-12-aaaaaaaaaaaa aaaa'], []], 'a kept worktree is never removed before add checks it');
  assert.deepEqual(readMarker(keptDir()), { pid: 5151, started: 'started 5151', kept: true });
});

test('a run without --keep gets a folder of its own and marks it in use while it runs', async () => {
  const { checkout } = fakeCheckout();
  let during: unknown;
  const { input } = prInput(checkout, {
    run: (p) => {
      during = readMarker(p.repoRoot);
      return Promise.resolve({ report: emptyReport({ version: 't', repo: p.repoRoot, command: 'c', change: p.change }), outDir: '/out' });
    },
  });
  await prCommand(input);
  assert.deepEqual(during, { pid: 4242, started: 'started 4242', kept: false });
});

test('a kept-folder run refuses a worktree a live run is using, and replaces one a stopped run left', async () => {
  mkdirSync(keptDir(), { recursive: true });
  writeFileSync(path.join(keptDir(), MARKER), JSON.stringify({ pid: 777, started: 'T', kept: false }));
  const busy = fakeCheckout();
  await assert.rejects(prCommand(prInput(busy.checkout, { keep: true, startOf: (pid) => (pid === 777 ? 'T' : undefined) }).input), (e: unknown) => e instanceof UsageError && e.message.includes('is in use by weakspot pr (process 777)'));
  assert.deepEqual(busy.events.filter((e) => e.startsWith('add') || e.startsWith('remove')), []);
  const reusedPid = fakeCheckout();
  await prCommand(prInput(reusedPid.checkout, { keep: true, startOf: (pid) => (pid === 777 ? 'later' : 'started') }).input);
  assert.deepEqual(reusedPid.events.filter((e) => e.startsWith('add') || e.startsWith('remove')), ['remove pr-12-aaaaaaaaaaaa', 'add pr-12-aaaaaaaaaaaa aaaa'], 'the same pid with another start time is another process');
});

test('a folder with no marker at the kept path is replaced, not reused', async () => {
  mkdirSync(keptDir(), { recursive: true });
  const { checkout, events } = fakeCheckout();
  await prCommand(prInput(checkout, { keep: true }).input);
  assert.deepEqual(events.filter((e) => e.startsWith('add') || e.startsWith('remove')), ['remove pr-12-aaaaaaaaaaaa', 'add pr-12-aaaaaaaaaaaa aaaa']);
});

test('processStart: a start time for a running process, none for one that has exited', () => {
  assert.match(processStart(process.pid)!, /\d{2}:\d{2}:\d{2}/);
  const child = spawnSync(process.execPath, ['-e', '0']);
  assert.equal(processStart(child.pid!), undefined);
});

test('pr --clean with the real check: a marker of this live process is in use, the same pid with another start time is not', () => {
  for (const [d, started] of [['pr-7-live', processStart(process.pid)], ['pr-8-reused', 'Mon Jan  1 00:00:00 2001']] as const) {
    mkdirSync(path.join(trees, d));
    writeFileSync(path.join(trees, d, MARKER), JSON.stringify({ pid: process.pid, started, kept: false }));
  }
  const { removed, inUse } = cleanWorktrees(fakeCheckout().checkout, '/main', trees);
  assert.deepEqual([removed.map((d) => path.basename(d)), inUse.map((d) => path.basename(d))], [['pr-8-reused'], ['pr-7-live']]);
});

test.each([false, true])('pr with keep %s: a failed run removes the worktree only without --keep, and a kept one is still marked kept', async (keep) => {
  const { checkout, events } = fakeCheckout();
  const { input } = prInput(checkout, { keep, run: () => Promise.reject(new Error('engine failed')) });
  await assert.rejects(prCommand(input), /engine failed/);
  assert.equal(events.some((e) => e.startsWith('remove')), !keep);
  if (keep) assert.deepEqual(readMarker(keptDir()), { pid: 4242, started: 'started 4242', kept: true });
});

test.each<[string | undefined, string]>([
  ['org/other', 'org/other'],
  ['', 'not a known repository'],
  [undefined, 'not a known repository'],
])('pr refuses a pull request of another repository than origin %j, before fetching', async (origin, named) => {
  const { checkout, events } = fakeCheckout({ origin });
  await assert.rejects(prCommand(prInput(checkout).input), (e: unknown) => e instanceof UsageError && e.message.includes(`is a pull request of org/app, but the origin of /main is ${named};`));
  assert.deepEqual(events, ['top /main']);
});

test('pr refuses when the head\'s lockfiles differ from the installed ones, before making a worktree', async () => {
  const { checkout, events } = fakeCheckout({ drift: ['pnpm-lock.yaml', 'services/web/package-lock.json'] });
  await assert.rejects(prCommand(prInput(checkout).input), (e: unknown) => e instanceof UsageError && exitCodeFor(e) === 2 && e.message.startsWith('pnpm-lock.yaml, services/web/package-lock.json at the head of pull request 12 differ from the ones installed in /main'));
  assert.deepEqual(events, ['top /main', 'fetch 12', 'drift aaaa']);
});

test('pr --specs resolve against --repo or the cwd, and must exist in the pull request\'s tree, which may add them', async () => {
  const { checkout } = fakeCheckout({ files: ['app/test/new.test.ts'] });
  const ok = prInput(checkout, { baseDir: '/main/app', specs: ['test/new.test.ts'] });
  await prCommand(ok.input);
  assert.deepEqual(ok.seen[0]!.specs, ['app/test/new.test.ts']);
  await assert.rejects(prCommand(prInput(checkout, { specs: ['test/gone.test.ts'] }).input), /spec test\/gone\.test\.ts is not in pull request 12 at aaaaaaaaaaaa/);
  await assert.rejects(prCommand(prInput(checkout, { specs: ['../elsewhere.test.ts'] }).input), /\/elsewhere\.test\.ts is outside the repo root \/main/);
});

test('pr --clean removes pr worktrees and folders left where one was, except those a live run is using', () => {
  for (const d of ['pr-1-x', 'pr-3-z', 'pr-4-busy', 'pr-5-kept', 'notes']) mkdirSync(path.join(trees, d));
  writeFileSync(path.join(trees, 'pr-4-busy', MARKER), JSON.stringify({ pid: 9, started: 'S', kept: false }));
  writeFileSync(path.join(trees, 'pr-5-kept', MARKER), JSON.stringify({ pid: 9, started: 'S', kept: true }));
  const { checkout, events } = fakeCheckout({ kept: [path.join(trees, 'pr-1-x'), path.join(trees, 'pr-2-y')] });
  const { removed, inUse } = cleanWorktrees(checkout, '/main', trees, (pid) => (pid === 9 ? 'S' : undefined));
  assert.deepEqual(removed.map((d) => path.basename(d)), ['pr-1-x', 'pr-2-y', 'pr-3-z', 'pr-5-kept']);
  assert.deepEqual(inUse.map((d) => path.basename(d)), ['pr-4-busy']);
  assert.deepEqual(events, ['remove pr-1-x', 'remove pr-2-y', 'remove pr-3-z', 'remove pr-5-kept']);
  assert.deepEqual(cleanWorktrees(fakeCheckout().checkout, '/main', path.join(trees, 'missing'), () => undefined), { removed: [], inUse: [] });
});
