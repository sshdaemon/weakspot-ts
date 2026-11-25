import assert from 'node:assert/strict';
import { test } from 'vitest';
import { TsPlaceholderFinder } from '../src/adapters/ts/placeholder-finder.ts';
import { applyAt, CONTEXT_LINES, excerptOf, innermostPerLine, lineStarts, normalized, onChangedLines, withIds, type FoundPlaceholder } from '../src/mutation/model.ts';

const finder = new TsPlaceholderFinder();

const SOURCE = [
  'export class Access {', // 1
  '  check(user: { role: string }, items: number[]) {', // 2
  "    if (user.role === 'admin') this.logger.info(items.length > 1 ? 'many' : 'one');", // 3
  '    for (const x of items) { this.repo.save(x, true); }', // 4
  '    for ( let i = 0; i < items.length; i++ ) {}', // 5
  '    while (items.length > 9) items.pop();', // 6
  '    do { items.shift(); } while (items.length > 5);', // 7
  '    switch (user.role) { default: break; }', // 8
  '    if (!items.length) throw new RangeError(`none for ${user.role}`);', // 9
  '    console.log(items.length === 1);', // 10
  '    return items.filter((x) => (x > 2 ? true : false)).map((x) => x * 2);', // 11
  '  }', // 12
  '}', // 13
  'export const make = () => new Access();', // 14
  '',
].join('\n');

const summary = (ps: readonly FoundPlaceholder[]) => ps.map((p) => `${p.start.line}:${p.start.column} ${p.kind} ${p.original}`);

test('placeholder kinds: conditions, loop headers, plain callees, argument lists and returned expressions, in source order', () => {
  assert.deepEqual(summary(finder.find('a.ts', SOURCE)), [
    "3:9 condition user.role === 'admin'",
    '4:10 loopHeader const x of items',
    '4:30 callee this.repo.save',
    '4:45 callArguments x, true',
    '5:11 loopHeader let i = 0; i < items.length; i++',
    '6:12 condition items.length > 9',
    '6:30 callee items.pop',
    '7:10 callee items.shift',
    '7:34 condition items.length > 5',
    '8:13 condition user.role',
    '9:9 condition !items.length',
    '11:12 returnExpression items.filter((x) => (x > 2 ? true : false)).map((x) => x * 2)',
    '11:12 callee items.filter',
    '11:25 callArguments (x) => (x > 2 ? true : false)',
    '11:32 returnExpression (x > 2 ? true : false)',
    '11:33 condition x > 2',
    '11:60 callArguments (x) => x * 2',
    '11:67 returnExpression x * 2',
    '14:27 returnExpression new Access()',
  ]);
});

test('logging calls and the arguments of an error built to be thrown hold no placeholders; a chain through a call is not a callee', () => {
  const originals = finder.find('a.ts', SOURCE).map((p) => p.original);
  assert.ok(!originals.some((o) => o.includes("'many'") || o.includes('items.length === 1') || o.includes('none for')));
  assert.ok(!originals.includes('items.filter((x) => (x > 2 ? true : false)).map'));
});

test('a range keeps the placeholders whose lines touch it; scope names the enclosing function', () => {
  const found = finder.find('a.ts', SOURCE).filter((p) => onChangedLines(p, [{ start: 6, end: 6 }]));
  assert.deepEqual(summary(found), ['6:12 condition items.length > 9', '6:30 callee items.pop']);
  assert.equal(found[0]!.scope, 'Access.check');
  assert.equal(finder.find('a.ts', SOURCE).at(-1)!.scope, 'make');
  assert.equal(onChangedLines({ start: { line: 3, column: 1 }, end: { line: 5, column: 1 } }, [{ start: 5, end: 9 }]), true);
  assert.equal(onChangedLines({ start: { line: 3, column: 1 }, end: { line: 5, column: 1 } }, [{ start: 6, end: 9 }]), false);
  assert.equal(onChangedLines({ start: { line: 3, column: 1 }, end: { line: 5, column: 1 } }, 'whole'), true);
  assert.deepEqual(summary(finder.find('a.ts', SOURCE).filter((p) => onChangedLines(p, [{ start: 6, end: 6 }, { start: 9, end: 9 }]))), ['6:12 condition items.length > 9', '6:30 callee items.pop', '9:9 condition !items.length'], 'a placeholder touching any one range is kept');
});

test('a thrown error loses only its message: later arguments, and errors that are not thrown, keep their placeholders', () => {
  const text = [
    'export function f(s: number, ok: boolean) {',
    "  if (!ok) throw new HttpException(s > 1 ? 'a' : 'b', s > 400 ? 403 : 401);",
    "  const e = new RangeError(s > 9 ? 'big' : 'small');",
    '  if (s) throw new ErrorsList(s > 2);',
    "  if (s === 3) throw new HttpException('Forbidden', 403);",
    "  if (s === 4) throw new errors.GoneError('Gone', HttpStatus.GONE);",
    '  return new Service(s, ok);',
    '}',
  ].join('\n');
  assert.deepEqual(summary(finder.find('a.ts', text)), [
    '2:7 condition !ok',
    '2:55 callArguments s > 400 ? 403 : 401',
    '2:55 condition s > 400',
    '3:28 callArguments s > 9 ? \'big\' : \'small\'',
    '3:28 condition s > 9',
    '4:7 condition s',
    '4:31 callArguments s > 2',
    '5:7 condition s === 3',
    '5:53 callArguments 403',
    '6:7 condition s === 4',
    '6:51 callArguments HttpStatus.GONE',
    '7:10 returnExpression new Service(s, ok)',
    '7:22 callArguments s, ok',
  ]);
  const status = finder.find('a.ts', text).find((x) => x.original === '403')!;
  assert.equal(finder.misfit('a.ts', text, status, '404'), undefined, 'a thrown error\'s later arguments take a mutant like any argument list');
});

test('a loop header is trimmed on each side by its own whitespace', () => {
  const text = 'for (  const x of xs ) {}\nfor (;;) {}\n';
  assert.deepEqual(summary(finder.find('a.ts', text)), ['1:8 loopHeader const x of xs']);
});

const kinds = (name: string, text: string) => summary(finder.find(name, text)).map((x) => x.split(' ')[1]);

test('.tsx and .jsx parse as TSX, anything else as TS', () => {
  const tsx = 'export const A = ({ on }: { on: boolean }) => <div>{on ? <b /> : null}</div>;\n';
  assert.deepEqual(kinds('a.tsx', tsx), ['returnExpression', 'condition']);
  assert.deepEqual(kinds('a.jsx', 'export const A = (p) => <i>{p.on ? 1 : 2}</i>;\n'), ['returnExpression', 'condition']);
  const generic = 'export const id = <T,>(x: T) => (x ? x : x);\n';
  assert.deepEqual(kinds('a.ts', generic), ['returnExpression', 'condition']);
  assert.deepEqual(kinds('a.mts', 'export const c = <T>(x: T) => x;\n'), ['returnExpression'], 'a type assertion style generic parses only as TS');
  assert.deepEqual(kinds('a.tsx', 'export const c = <T>(x: T) => x;\n'), [], 'and not as TSX');
});

test('misfit: the source must still read the original, parse, and hold the replacement as a whole placeholder of the same kind', () => {
  const found = finder.find('a.ts', SOURCE);
  const cond = found.find((p) => p.kind === 'condition')!;
  const loop = found.find((p) => p.kind === 'loopHeader')!;
  const args = found.find((p) => p.kind === 'callArguments')!;
  const callee = found.find((p) => p.kind === 'callee')!;
  assert.equal(finder.misfit('a.ts', SOURCE, cond, "user.role !== 'admin'"), undefined);
  assert.equal(finder.misfit('a.ts', SOURCE, loop, 'const x in items'), undefined);
  assert.equal(finder.misfit('a.ts', SOURCE, args, 'true, x'), undefined);
  assert.equal(finder.misfit('a.ts', SOURCE, args, ''), undefined, 'an empty argument list is allowed');
  assert.match(finder.misfit('a.ts', SOURCE, args, 'x, true); this.repo.drop(x')!, /^is not a whole callArguments/);
  const ret = found.find((p) => p.kind === 'returnExpression')!;
  assert.match(finder.misfit('a.ts', SOURCE, ret, '')!, /^is not a whole returnExpression/, 'only an argument list may be emptied');
  assert.equal(finder.misfit('a.ts', SOURCE, callee, 'this.repo.remove'), undefined);
  assert.match(finder.misfit('a.ts', SOURCE, cond, "user.role ===")!, /^does not parse: /);
  assert.match(finder.misfit('a.ts', SOURCE, cond, "user.role === 'admin') return; if (true")!, /^is not a whole condition/);
  assert.match(finder.misfit('a.ts', SOURCE, callee, 'this.repo.save(x); this.repo.drop')!, /^is not a whole callee/);
  assert.match(finder.misfit('a.ts', SOURCE.replace("'admin'", "'staff'"), cond, 'true')!, /^the source changed since propose: line 3 no longer reads/);
  assert.match(finder.misfit('a.ts', 'x\n', cond, 'true')!, /^the source changed since propose/, 'a line past the end is stale, not a crash');
  const broken = `${SOURCE}\nexport const z = (;\n`;
  assert.equal(finder.misfit('a.ts', broken, cond, 'true'), undefined, 'errors already in the file do not count against the mutant');
});

const p = (line: number, original: string, scope = 'f'): FoundPlaceholder => ({ kind: 'condition', start: { line, column: 5 }, end: { line, column: 5 + original.length }, original, scope });
const at = (line: number): FoundPlaceholder => ({ kind: 'condition', start: { line, column: 1 }, end: { line, column: 3 }, original: 'l', scope: '' });

test('ids: file, kind and a hash of scope and text; repeats in one scope are numbered; a line shift keeps them', () => {
  const ids = withIds('src/a.ts', [p(3, 'a > 1'), p(9, 'a > 1'), p(12, 'a > 1', 'g'), p(14, 'b')]).map((x) => x.id);
  assert.match(ids[0]!, /^src\/a\.ts#condition#[0-9a-f]{12}$/);
  assert.deepEqual([ids[1], ids[2] === ids[0], ids[3] === ids[0]], [`${ids[0]}~2`, false, false]);
  assert.deepEqual(withIds('src/a.ts', [p(30, 'a > 1')]).map((x) => x.id), [ids[0]]);
});

test('excerpt: the context lines around the first and last placeholder, clipped to the file', () => {
  const text = Array.from({ length: 200 }, (_, i) => `l${i + 1}`).join('\n');
  const mid = excerptOf(text, [at(100), at(110)]);
  assert.equal(mid.startLine, 100 - CONTEXT_LINES);
  assert.deepEqual([mid.text.split('\n')[0], mid.text.split('\n').at(-1)], [`l${100 - CONTEXT_LINES}`, `l${110 + CONTEXT_LINES}`]);
  const edges = excerptOf(text, [at(2), at(199)]);
  assert.deepEqual([edges.startLine, edges.text.split('\n').length], [1, 200]);
});

test('applyAt replaces between 1-based positions across lines; normalized ignores whitespace', () => {
  assert.equal(applyAt('ab\ncd\nef\n', { line: 1, column: 2 }, { line: 3, column: 2 }, 'X'), 'aXf\n');
  assert.equal(applyAt('if (a) x;\n', { line: 1, column: 5 }, { line: 1, column: 6 }, '!a'), 'if (!a) x;\n');
  assert.equal(normalized('  a  >\n 1 '), 'a > 1');
});

test.each<[string, string]>([
  ['CRLF', 'const a = 1;\r\nif (a > 1) x();\r\n'],
  ['a lone CR', 'const a = 1;\rif (a > 1) x();\r'],
  ['U+2028', '// a note\nif (a > 1) x();\n'],
  ['U+2029', '// a note\nif (a > 1) x();\n'],
])('positions from the parser line up with applyAt and excerptOf after %s', (_name, text) => {
  const cond = finder.find('a.ts', text).find((x) => x.kind === 'condition')!;
  assert.equal(cond.original, 'a > 1');
  assert.equal(applyAt(text, cond.start, cond.end, 'a >= 1'), text.replace('a > 1', 'a >= 1'));
  assert.equal(excerptOf(text, [cond]).text, text.replace(/(\r\n|\r|\n)$/, ''));
  assert.equal(lineStarts(text).length, cond.start.line + 1);
});

test('statements that are not calls get a placeholder, which may be emptied; a JSX && gets its condition', () => {
  const text = ['export function f(a: { n: number }, d: { n: number }) {', '  a.n = d.n;', '  a.n++;', '  void g(a);', '  await h(a);', '}'].join('\n');
  const found = finder.find('a.ts', text);
  assert.deepEqual(summary(found).filter((x) => x.includes('statement')), ['2:3 statement a.n = d.n', '3:3 statement a.n++', '4:3 statement void g(a)']);
  const assign = found.find((x) => x.kind === 'statement')!;
  assert.equal(finder.misfit('a.ts', text, assign, ''), undefined, 'removing the statement is a mutant');
  assert.equal(finder.misfit('a.ts', text, assign, 'a.n = a.n'), undefined);
  const tsx = 'export const B = ({ admin }: { admin: boolean }) => <div>{admin && <Bar />}</div>;\n';
  assert.ok(summary(finder.find('a.tsx', tsx)).includes('1:59 condition admin'));
});

test('a span holding a function or JSX is wide; on a changed line it gives way to anything smaller there', () => {
  const text = [
    'export async function save(ds: any, dto: { id: number }) {',
    '  await ds.transaction(async (em: any) => {',
    '    const a = await em.find(dto.id);',
    '    a.ownerId = dto.id;',
    '    return em.save(a);',
    '  });',
    '}',
  ].join('\n');
  const found = finder.find('a.ts', text);
  const args = found.find((x) => x.kind === 'callArguments' && x.start.line === 2)!;
  assert.equal(args.wide, true);
  assert.equal(found.find((x) => x.original === 'dto.id' && x.kind === 'callArguments')!.wide, undefined);
  const kept = (ranges: { start: number; end: number }[]) => innermostPerLine(found.filter((x) => onChangedLines(x, ranges)), ranges).map((x) => `${x.start.line} ${x.kind} ${x.original.split('\n')[0]}`);
  assert.deepEqual(kept([{ start: 4, end: 4 }]), ['4 statement a.ownerId = dto.id']);
  assert.deepEqual(kept([{ start: 2, end: 2 }]), ['2 callee ds.transaction'], 'the callee is smaller and on the changed line');
  assert.deepEqual(kept([{ start: 6, end: 6 }]), ['2 callArguments async (em: any) => {'], 'the closing line has nothing smaller');
  const jsx = 'export const P = () => (\n  <div>\n    <b>hi</b>\n  </div>\n);\n';
  const jsxFound = finder.find('a.tsx', jsx);
  assert.deepEqual(innermostPerLine(jsxFound, [{ start: 3, end: 3 }]).map((x) => x.kind), ['returnExpression'], 'a wide span stays when it is all there is');
});

test('innermost per line looks at each changed line on its own, and only at smaller placeholders on that line', () => {
  const text = [
    'export function f(rows: { price: number; qty: number }[]) {',
    '  rows.forEach((r) => {',
    '    const total = r.price * r.qty;',
    '    save(r, total);',
    '  });',
    '}',
  ].join('\n');
  const found = finder.find('a.ts', text);
  const kept = (ranges: { start: number; end: number }[]) => innermostPerLine(found.filter((x) => onChangedLines(x, ranges)), ranges).map((x) => `${x.start.line} ${x.kind} ${x.original.split('\n')[0]}`);
  const wideArgs = '2 callArguments (r) => {';
  assert.ok(kept([{ start: 3, end: 4 }]).includes(wideArgs), 'line 3 has nothing smaller, so the callback stays');
  assert.ok(kept([{ start: 3, end: 3 }, { start: 4, end: 4 }]).includes(wideArgs), 'the same with the two lines as two ranges');
  assert.ok(!kept([{ start: 4, end: 4 }]).includes(wideArgs), 'line 4 alone has smaller placeholders');
  assert.ok(innermostPerLine(found, 'whole').some((x) => x.wide), 'a whole file keeps the callback for its bare line 3');
  const big = { kind: 'callArguments' as const, start: { line: 1, column: 1 }, end: { line: 1, column: 9 }, original: '() => {}', scope: '', wide: true as const };
  const { wide: _wide, ...plain } = big;
  const bigger = { ...plain, kind: 'returnExpression' as const, original: 'run(() => {})' };
  assert.deepEqual(innermostPerLine([big, bigger], [{ start: 1, end: 1 }]).length, 2, 'a larger placeholder on the line does not count');
  const elsewhere = { ...bigger, original: 'x', start: { line: 2, column: 1 }, end: { line: 2, column: 2 } };
  assert.deepEqual(innermostPerLine([big, elsewhere], [{ start: 1, end: 2 }]).length, 2, 'a smaller one on another line does not count');
  const sameSize = { ...plain, kind: 'callee' as const, original: 'run(1)()' };
  assert.deepEqual(innermostPerLine([big, sameSize], [{ start: 1, end: 1 }]).length, 2, 'one of the same size does not count');
  const twoLines = { ...big, end: { line: 2, column: 3 }, original: '() => {\n}' };
  const above = { ...plain, kind: 'callee' as const, original: 'f' };
  assert.deepEqual(innermostPerLine([twoLines, above], [{ start: 2, end: 2 }]).length, 2, 'a smaller one that ends above the changed line does not count');
});

test('a function outside the span does not make it wide', () => {
  const text = 'export function g(rows: { ok: boolean }[]) {\n  for (const x of rows) { rows.map((y) => y); }\n  return rows.filter((r) => r.ok).map(toDto);\n}\n';
  const found = finder.find('a.ts', text);
  assert.equal(found.find((x) => x.kind === 'loopHeader')!.wide, undefined);
  assert.equal(found.find((x) => x.kind === 'callArguments' && x.original === 'toDto')!.wide, undefined);
  assert.equal(found.find((x) => x.kind === 'callArguments' && x.original === '(r) => r.ok')!.wide, true);
});

test('only a JSX && gives its left side a condition; ||, ?? and an if keep their own placeholders', () => {
  const tsx = "export const C = ({ a, b, label }: any) => <p>{a || <X />}{label ?? 'none'}{a && b}</p>;\n";
  assert.deepEqual(summary(finder.find('a.tsx', tsx)).filter((x) => x.includes('condition')), ['1:77 condition a']);
  assert.deepEqual(summary(finder.find('a.ts', 'if (a && b) go();\n')).filter((x) => x.includes('condition')), ['1:5 condition a && b']);
});
