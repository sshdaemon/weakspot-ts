import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'vitest';
import { SandboxNotLoadedError, TestsFailBeforeMutationError } from '../src/mutation/errors.ts';
import { MODEL_WORKER_VARIABLE, runModelJob, statusOf, type ModelJob } from '../src/mutation/model-run.ts';
import type { Placeholder } from '../src/mutation/model.ts';
import type { ValidMutant } from '../src/mutation/validate.ts';
import type { Sandbox, SandboxFactory } from '../src/ports/sandbox.ts';
import type { RunOptions, RunResult, ShimOptions, TestRunner } from '../src/ports/test-runner.ts';

const repo = '/r';
const pkg = { name: 'app', dir: '/r/app', testConfig: '/r/app/vitest.config.ts' };
const lane = { name: 'unit', timeoutMs: 1000, concurrency: 2, env: { DB: 'db_{worker}' } };
const placeholder: Placeholder = { id: 'p', file: 'app/src/a.ts', kind: 'condition', start: { line: 1, column: 5 }, end: { line: 1, column: 10 }, original: 'a > 1', scope: 'f' };
const mutant = (replacement: string): ValidMutant => ({ placeholder: 'p', replacement, because: `because ${replacement}`, target: placeholder, cached: false });

interface Call {
  readonly shim: string;
  readonly include: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly env: Readonly<Record<string, string>> | undefined;
  readonly text: string;
  /** Every file written into the sandbox at the time of the run. */
  readonly written: Readonly<Record<string, string>>;
}

type Kind = 'dry' | 'canary' | 'mutant';
const kindOf = (shim: string): Kind => {
  if (shim === 'dry.shim.mts') return 'dry';
  return shim.startsWith('canary') ? 'canary' : 'mutant';
};

/** Sandboxes that record writes in memory; a runner whose result depends on the mutated text. A canary run gets `canary`: a file that fails to load, by default. */
function harness(result: (text: string, kind: Kind) => Partial<RunResult>, canary: Partial<RunResult> = { failedFiles: 1 }) {
  const calls: Call[] = [];
  const events: string[] = [];
  const files = new Map<string, string>();
  const shims = new Map<string, ShimOptions>();
  const sandboxes: SandboxFactory = {
    create: (_pkgDir, at): Sandbox => {
      events.push(`create ${path.relative('/out', at)}`);
      return {
        dir: at,
        write: (file, text) => files.set(`${at}/${file}`, text),
        restore: (file) => files.delete(`${at}/${file}`),
        dispose: () => events.push(`dispose ${path.relative('/out', at)}`),
      };
    },
  };
  const runner: TestRunner = {
    name: 'fake',
    detect: () => true,
    engineConfig: () => ({}),
    writeShim: (_pkg, opts, outPath) => {
      shims.set(outPath, opts);
      return outPath;
    },
    run: (_pkg, shim, cwd, timeoutMs, opts?: RunOptions) => {
      const text = files.get(`${cwd}/src/a.ts`) ?? '';
      const written = Object.fromEntries([...files].filter(([k]) => k.startsWith(`${cwd}/`)).map(([k, v]) => [k.slice(cwd.length + 1), v]));
      const kind = kindOf(path.basename(shim));
      calls.push({ shim: path.basename(shim), include: shims.get(shim)!.include ?? [], cwd: path.relative('/out', cwd), timeoutMs, env: opts?.env, text, written });
      return Promise.resolve({ passed: 0, failed: 0, failedFiles: 0, timedOut: false, durationMs: 400, output: 'out', ...(kind === 'canary' ? canary : result(text, kind)) });
    },
  };
  return { calls, events, shims, sandboxes, runner };
}

const job = (mutants: ValidMutant[]): ModelJob => ({ lane, pkg, files: new Map([['app/src/a.ts', ['app/src/a.test.ts']]]), mutants });

function options(h: ReturnType<typeof harness>, signal = new AbortController().signal) {
  return { repoRoot: repo, workDir: '/out', runner: h.runner, sandboxes: h.sandboxes, workerOffset: 100, readSource: () => 'if (a > 1) go();\n', log: () => {}, signal };
}

test('a dry run first, then each mutant written into a worker sandbox, run with its file specs and put back', async () => {
  const h = harness((text, kind) => ({ passed: 4, failed: kind === 'mutant' && text.includes('a >= 1') ? 1 : 0 }));
  const result = await runModelJob(job([mutant('a >= 1'), mutant('a < 1'), mutant('true')]), options(h));
  assert.deepEqual(result.mutants.map((m) => [m.id, m.status, m.statusReason, m.coveredBy, m.because, m.scope]), [
    ['app/src/a.ts#unit#model-1', 'Killed', '1 test(s) failed', 5, 'because a >= 1', 'f'],
    ['app/src/a.ts#unit#model-2', 'Survived', '', 4, 'because a < 1', 'f'],
    ['app/src/a.ts#unit#model-3', 'Survived', '', 4, 'because true', 'f'],
  ]);
  assert.deepEqual([result.mutants[0]!.mutator, result.mutants[0]!.original, result.mutants[0]!.replacement, result.testCount], ['model', 'a > 1', 'a >= 1', 4]);
  assert.deepEqual(h.calls[0], { shim: 'dry.shim.mts', include: ['src/a.test.ts'], cwd: 'w0/pkg', timeoutMs: 300_000, env: { [MODEL_WORKER_VARIABLE]: '0' }, text: '', written: {} });
  assert.deepEqual([h.calls[1]!.shim, h.calls[1]!.cwd, h.calls[1]!.text.startsWith("throw new Error('weakspot:")], ['canary0.shim.mts', 'w0/pkg', true], 'the canary runs before any mutant');
  const mutantRuns = h.calls.slice(2);
  assert.deepEqual(new Set(mutantRuns.map((c) => c.timeoutMs)), new Set([1000 + 600]), 'the lane limit plus 1.5 times the dry run');
  assert.deepEqual(new Set(mutantRuns.map((c) => c.cwd)), new Set(['w0/pkg', 'w1/pkg']), 'two workers, as the lane allows');
  assert.ok(mutantRuns.every((c) => c.text.startsWith('if (') && !c.text.includes('a > 1)')), 'the runner saw the mutated text');
  const shim = h.shims.get('/out/w1/f0.shim.mts')!;
  assert.deepEqual([shim.root, shim.env, shim.workerIdVariable, shim.workerOffset], ['cwd', lane.env, MODEL_WORKER_VARIABLE, 100]);
  assert.deepEqual(h.events.toSorted(), ['create w0/pkg', 'create w1/pkg', 'dispose w0/pkg', 'dispose w1/pkg']);
});

test('one mutant needs one worker; no mutants run nothing', async () => {
  const h = harness(() => ({ passed: 1 }));
  await runModelJob({ ...job([mutant('x')]), lane: { ...lane, concurrency: 8 } }, options(h));
  assert.deepEqual(h.events, ['create w0/pkg', 'dispose w0/pkg']);
  const none = harness(() => ({ passed: 1 }));
  assert.deepEqual(await runModelJob(job([]), options(none)), { mutants: [], testCount: 0, durationMs: 0 });
  assert.deepEqual(none.calls, []);
});

test.each<[string, Partial<RunResult>]>([
  ['red', { passed: 3, failed: 1 }],
  ['file-failing', { passed: 3, failedFiles: 1 }],
  ['empty', { passed: 0 }],
  ['timed out', { passed: 2, timedOut: true }],
])('a %s dry run stops the job and still removes the sandbox', async (_name, dry) => {
  const h = harness(() => dry);
  await assert.rejects(runModelJob(job([mutant('x')]), options(h)), (e: unknown) => e instanceof TestsFailBeforeMutationError && /tests fail before mutation in app/.test(e.message));
  assert.deepEqual(h.events, ['create w0/pkg', 'dispose w0/pkg']);
});

test('an aborted job takes no further mutants', async () => {
  const controller = new AbortController();
  const h = harness((_text, kind) => {
    if (kind === 'mutant') controller.abort();
    return { passed: 1 };
  });
  const result = await runModelJob({ ...job([mutant('a'), mutant('b'), mutant('c')]), lane: { ...lane, concurrency: 1 } }, options(h, controller.signal));
  assert.equal(result.mutants.length, 1);
});

test('statusOf: timeout, then a failing test, then a failing spec file, then passing tests; nothing run is an error with the output', () => {
  assert.deepEqual(statusOf({ passed: 5, failed: 0, failedFiles: 2, timedOut: false, output: '' }), { status: 'Killed', reason: '2 spec file(s) failed to load or run' });
  assert.deepEqual(statusOf({ passed: 1, failed: 1, failedFiles: 0, timedOut: true, output: '' }), { status: 'Timeout', reason: '' });
  assert.deepEqual(statusOf({ passed: 1, failed: 2, failedFiles: 1, timedOut: false, output: '' }), { status: 'Killed', reason: '2 test(s) failed' });
  assert.deepEqual(statusOf({ passed: 3, failed: 0, failedFiles: 0, timedOut: false, output: '' }), { status: 'Survived', reason: '' });
  assert.deepEqual(statusOf({ passed: 0, failed: 0, failedFiles: 0, timedOut: false, output: 'a\nb\n' }), { status: 'RuntimeError', reason: 'a\nb' });
  assert.deepEqual(statusOf({ passed: 0, failed: 0, failedFiles: 0, timedOut: false, output: '' }), { status: 'RuntimeError', reason: 'no test ran' });
});

const placeholderB: Placeholder = { ...placeholder, id: 'q', file: 'app/src/b.ts', original: 'b' };

test('a job over two files: every canary and mutant runs with only its own file changed; a runner crash stops the job and removes the sandbox', async () => {
  const h = harness(() => ({ passed: 2 }));
  let throwOnce = true;
  const run = h.runner.run.bind(h.runner);
  h.runner.run = (p, shim, cwd, timeoutMs, opts) => {
    if (kindOf(path.basename(shim)) === 'mutant' && throwOnce) {
      throwOnce = false;
      return Promise.reject(new Error('runner crashed'));
    }
    return run(p, shim, cwd, timeoutMs, opts);
  };
  const two: ModelJob = {
    lane: { ...lane, concurrency: 1 },
    pkg,
    files: new Map([['app/src/a.ts', ['app/src/a.test.ts']], ['app/src/b.ts', ['app/src/b.test.ts']]]),
    mutants: [mutant('a >= 1'), { ...mutant('c'), placeholder: 'q', target: placeholderB }],
  };
  await assert.rejects(runModelJob(two, options(h)), /runner crashed/);
  assert.deepEqual(h.events, ['create w0/pkg', 'dispose w0/pkg']);
  const again = harness(() => ({ passed: 2 }));
  await runModelJob(two, options(again));
  const runs = again.calls.filter((c) => c.shim !== 'dry.shim.mts');
  assert.deepEqual(runs.map((c) => [c.shim, Object.keys(c.written), c.include]), [
    ['canary0.shim.mts', ['src/a.ts'], ['src/a.test.ts']],
    ['canary1.shim.mts', ['src/b.ts'], ['src/b.test.ts']],
    ['f0.shim.mts', ['src/a.ts'], ['src/a.test.ts']],
    ['f1.shim.mts', ['src/b.ts'], ['src/b.test.ts']],
  ]);
});

test('a file whose specs pass with the canary in place stops the job: the specs never load the sandbox copy', async () => {
  const h = harness(() => ({ passed: 2 }), { passed: 2 });
  await assert.rejects(runModelJob(job([mutant('x')]), options(h)), (e: unknown) => e instanceof SandboxNotLoadedError && /never loaded the sandbox copy of: app\/src\/a\.ts/.test(e.message));
  assert.deepEqual(h.events, ['create w0/pkg', 'dispose w0/pkg']);
});

test.each<[string, Partial<RunResult>]>([
  ['a failing test', { passed: 1, failed: 1 }],
  ['a timeout', { passed: 0, timedOut: true }],
])('a canary run that ends in %s shows the copy was loaded', async (_name, canary) => {
  const loaded = harness(() => ({ passed: 2 }), canary);
  assert.equal((await runModelJob(job([mutant('x')]), options(loaded))).mutants.length, 1);
});
