import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, test } from 'vitest';
import { TsSourceInspector } from '../src/adapters/ts/source-inspector.ts';
import type { Mutant } from '../src/mutation/types.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'weakspot-inspect-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A mutant over the first occurrence of `target` in `text`, with 1-based line and column like Stryker's. */
function mutantAt(text: string, target: string, id: string): Mutant {
  const at = text.indexOf(target);
  assert.ok(at !== -1, `fixture lacks ${target}`);
  const pos = (offset: number) => {
    const before = text.slice(0, offset).split('\n');
    return { line: before.length, column: before.at(-1)!.length + 1 };
  };
  return { id, file: 'f', lane: 'unit', mutator: 'ConditionalExpression', start: pos(at), end: pos(at + target.length), original: target, replacement: 'true', status: 'Survived', statusReason: '', coveredBy: 1, isStatic: false, killedBy: [] };
}

function inspect(name: string, text: string, targets: Record<string, string>) {
  const file = path.join(dir, name);
  writeFileSync(file, text);
  const sites = new TsSourceInspector().inspect(file, Object.entries(targets).map(([id, t]) => mutantAt(text, t, id)));
  return Object.fromEntries(Object.keys(targets).map((id) => [id, sites.get(id)]));
}

const noiseOf = (name: string, text: string, targets: Record<string, string>) =>
  Object.fromEntries(Object.entries(inspect(name, text, targets)).map(([id, site]) => [id, site?.noise]));

test('logging: console, a log or logger object with a level method, a bare log(); near misses are not', () => {
  const text = [
    'export class S {',
    '  run(a: number) {',
    "    console.log(a > 1 ? 'big' : 'small');",
    '    this.logger.warn(`seen ${a + 1}`);',
    '    log(a === 2);',
    '    this.logger.flush(a > 3);',
    '    save(a > 4);',
    '    this.catalog.warn(a > 5);',
    '    loggerFactory.info(a > 6);',
    '    handlers[kind](a > 8);',
    '    make()(a > 9);',
    '    if (a > 7) return a;',
    '    return 0;',
    '  }',
    '}',
  ].join('\n');
  assert.deepEqual(noiseOf('logging.ts', text, { console: 'a > 1', logger: 'a + 1', bare: 'a === 2', notLevel: 'a > 3', otherCall: 'a > 4', catalog: 'a > 5', factory: 'a > 6', computed: 'a > 8', returned: 'a > 9', plain: 'a > 7' }), {
    console: 'logging',
    logger: 'logging',
    bare: 'logging',
    notLevel: undefined,
    otherCall: undefined,
    catalog: undefined,
    factory: undefined,
    computed: undefined,
    returned: undefined,
    plain: undefined,
  });
});

test('errorMessage: only the message of an error thrown directly', () => {
  const text = [
    'export function f(a: number) {',
    '  if (a < 0) throw new RangeError(`bad ${a * 2}`);',
    "  if (a > 9) throw new errors.BadRequestException(a > 99 ? 'huge' : 'big');",
    "  if (a > 8) throw new HttpException('conflict', a > 88 ? 409 : 400);",
    '  const e = new TypeError(`kept ${a - 3}`);',
    '  if (a > 7) throw new ErrorBoundary(a + 5);',
    '  return [e, new Thing(a + 7)];',
    '}',
  ].join('\n');
  assert.deepEqual(noiseOf('errors.ts', text, { cond: 'a < 0', message: 'a * 2', nested: 'a > 99', status: 'a > 88', notThrown: 'a - 3', notError: 'a + 5', other: 'a + 7' }), {
    cond: undefined,
    message: 'errorMessage',
    nested: 'errorMessage',
    status: undefined,
    notThrown: undefined,
    notError: undefined,
    other: undefined,
  });
});

test('catchOnly: a catch block that only logs or rethrows; a catch with logic is not noise', () => {
  const text = [
    'export function f(a: number, repo: { find(n: number): number }) {',
    '  try {',
    '    return a > 1;',
    '  } catch (err) {',
    '    console.error(a > 2);',
    '    throw err;',
    '  }',
    '}',
    'export function g(a: number, repo: { find(n: number): number }) {',
    '  try {',
    '    return a > 3;',
    '  } catch (err) {',
    "    if ((err as { code: string }).code === 'DUP') return repo.find(a);",
    '    throw err;',
    '  }',
    '}',
  ].join('\n');
  assert.deepEqual(noiseOf('catch.ts', text, { tryBody: 'a > 1', reports: 'a > 2', fallback: "=== 'DUP'" }), { tryBody: undefined, reports: 'logging', fallback: undefined });
  const onlyLogs = ['export function h(a: number) {', '  try {', '    return 1;', '  } catch {', '    logger.warn(`failed ${a > 4}`);', '  }', '}'].join('\n');
  assert.deepEqual(noiseOf('catch2.ts', onlyLogs, { inLog: 'a > 4', block: '{\n    logger.warn(`failed ${a > 4}`);\n  }' }), { inLog: 'logging', block: 'catchOnly' }, 'a catch with no binding that only logs');
});

test('catchOnly: a log-and-rethrow catch hides its block, but a catch that throws a new error keeps its arguments', () => {
  const text = [
    'export function f(a: number) {',
    '  try {',
    '    return a;',
    '  } catch (err) {',
    "    console.error('failed', err);",
    '    throw err;',
    '  }',
    '}',
    'export function g(a: number) {',
    '  try {',
    '    return a;',
    '  } catch (err) {',
    "    logger.error('failed');",
    "    throw new HttpException('upstream', (err as { status: number }).status === 404 ? 404 : 502);",
    '  }',
    '}',
  ].join('\n');
  const block = "{\n    console.error('failed', err);\n    throw err;\n  }";
  assert.deepEqual(noiseOf('rethrow.ts', text, { block, status: '.status === 404' }), { block: 'catchOnly', status: undefined });
  const nearMisses = [
    'export function i(a: number, other: Error) {',
    '  try {',
    '    return a;',
    '  } catch (err) {',
    '    console.error(err);',
    '    throw other;',
    '  }',
    '}',
    'export function j(a: number) {',
    '  try {',
    '    return a;',
    '  } catch (err) {',
    '    logger.warn(err);',
    '    return err;',
    '  }',
    '}',
  ].join('\n');
  assert.deepEqual(
    noiseOf('near-miss.ts', nearMisses, { otherError: '{\n    console.error(err);\n    throw other;\n  }', swallowed: '{\n    logger.warn(err);\n    return err;\n  }' }),
    { otherError: undefined, swallowed: undefined },
    'throwing another error, or returning the caught one, is behaviour',
  );
});

test('functions: a callback in a thrown error or in className is behaviour; one inside a logging call is still logging', () => {
  const text = [
    'export function f(errs: { fatal: boolean }[], items: { a: number }[], p: { on: boolean }) {',
    '  logger.info(items.map((i) => i.a > 1));',
    '  if (errs.length > 0) throw new ValidationError(errs.filter((e) => e.fatal === true));',
    '  return <div className={pick(() => p.on && true)} />;',
    '}',
  ].join('\n');
  assert.deepEqual(noiseOf('callbacks.tsx', text, { inLog: 'i.a > 1', inError: 'e.fatal === true', inClass: 'p.on && true' }), { inLog: 'logging', inError: undefined, inClass: undefined });
});

test('jsxAttribute: literal values and className, class or style; handlers and render conditions are not', () => {
  const text = [
    'export const C = (p: { on: boolean; busy: boolean; ok: boolean; save(): void }) => (',
    "  <button className={p.on ? 'a' : 'b'} style={{ opacity: p.busy ? 0.5 : 1 }} title={`t ${p.on && 'x'}`} disabled={p.busy || !p.ok} onClick={() => { if (p.ok) p.save(); }}>",
    "    {p.busy && 'y'}",
    '  </button>',
    ');',
  ].join('\n');
  assert.deepEqual(noiseOf('c.tsx', text, { className: "p.on ? 'a' : 'b'", style: 'p.busy ? 0.5 : 1', title: "p.on && 'x'}`", disabled: 'p.busy || !p.ok', handler: 'if (p.ok)', child: "{p.busy && 'y'}" }), {
    className: 'jsxAttribute',
    style: 'jsxAttribute',
    title: 'jsxAttribute',
    disabled: undefined,
    handler: undefined,
    child: undefined,
  });
});

test('scope: named functions and classes outermost first; an arrow takes the name it is assigned to; module level is empty', () => {
  const text = [
    'const top = 1 > 0;',
    'export class Svc {',
    '  run(a: number) {',
    '    const pick = (b: number) => b > 2;',
    '    return pick(a) && a > 3;',
    '  }',
    '}',
    'export function plain(a: number) {',
    '  return [a].map((x) => x > 4);',
    '}',
  ].join('\n');
  const scopes = Object.fromEntries(Object.entries(inspect('scope.ts', text, { top: '1 > 0', arrow: 'b > 2', method: 'a > 3', callback: 'x > 4' })).map(([id, s]) => [id, s?.scope]));
  assert.deepEqual(scopes, { top: '', arrow: 'Svc.run.pick', method: 'Svc.run', callback: 'plain' });
});

test('a missing file or a position past the end yields nothing', () => {
  const m = mutantAt('a > 1', 'a > 1', 'x');
  assert.equal(new TsSourceInspector().inspect(path.join(dir, 'missing.ts'), [m]).size, 0);
  const file = path.join(dir, 'short.ts');
  writeFileSync(file, 'x');
  assert.equal(new TsSourceInspector().inspect(file, [{ ...m, start: { line: 9, column: 1 }, end: { line: 9, column: 2 } }]).size, 0);
});
