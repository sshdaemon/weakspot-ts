import ts from 'typescript';
import type { FoundPlaceholder, PlaceholderKind } from '../../mutation/model.ts';
import type { Position } from '../../mutation/types.ts';
import type { PlaceholderFinder } from '../../ports/placeholder-finder.ts';
import { isLoggingCall, scopeOf } from './source-inspector.ts';

interface Span {
  readonly kind: PlaceholderKind;
  readonly start: number;
  readonly end: number;
  readonly node: ts.Node;
}

/**
 * Placeholders after LLMorpheus: conditions (if, ternary, while, do, switch, a JSX `&&`), loop
 * headers, call targets and argument lists, returned expressions, and statements that are not calls
 * (an assignment, an increment). Logging calls and the message of an error
 * thrown directly are left out: a mutant there says nothing about behaviour. A thrown error's other
 * arguments, such as a status code, are behaviour and keep their placeholders.
 */
export class TsPlaceholderFinder implements PlaceholderFinder {
  find(fileName: string, text: string): FoundPlaceholder[] {
    const sf = parse(fileName, text);
    return spansOf(sf).map((s) => found(sf, s));
  }

  misfit(fileName: string, text: string, p: FoundPlaceholder, replacement: string): string | undefined {
    const sf = parse(fileName, text);
    const start = offsetOf(sf, p.start);
    const end = offsetOf(sf, p.end);
    if (start === undefined || end === undefined || text.slice(start, end) !== p.original) return `the source changed since propose: line ${p.start.line} no longer reads \`${p.original}\``;
    const mutated = text.slice(0, start) + replacement + text.slice(end);
    const before = syntaxErrors(fileName, text);
    const after = syntaxErrors(fileName, mutated);
    if (after.length > before.length) return `does not parse: ${after[0]}`;
    // An empty argument list is a valid mutant with no span of its own to find again.
    if ((p.kind === 'callArguments' || p.kind === 'statement') && replacement === '') return undefined;
    const fits = spansOf(parse(fileName, mutated)).some((s) => s.kind === p.kind && s.start === start && s.end === start + replacement.length);
    return fits ? undefined : `is not a whole ${p.kind}: the replacement must stand in for exactly \`${p.original}\` and nothing around it`;
  }
}

function parse(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, /\.[cm]?tsx$|\.jsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** Syntax errors only: the transpiler reports what the parser rejects, never type errors. */
function syntaxErrors(fileName: string, text: string): string[] {
  const out = ts.transpileModule(text, { fileName, reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.Latest } });
  return (out.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));
}

function spansOf(sf: ts.SourceFile): Span[] {
  const out: Span[] = [];
  const add = (kind: PlaceholderKind, node: ts.Node, start = node.getStart(sf), end = node.getEnd()) => {
    if (end > start) out.push({ kind, start, end, node });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isLoggingCall(node)) return;
    if (isThrownError(node)) {
      const rest = node.arguments?.slice(1) ?? [];
      if (rest.length > 0) add('callArguments', node, rest[0]!.getStart(sf), rest.at(-1)!.getEnd());
      rest.forEach(visit);
      return;
    }
    if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isSwitchStatement(node)) add('condition', node.expression);
    if (ts.isConditionalExpression(node)) add('condition', node.condition);
    if (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) {
      const header = headerOf(sf, node);
      if (header) add('loopHeader', node, header.start, header.end);
    }
    if (ts.isCallExpression(node)) {
      if (isPlainCallee(node.expression)) add('callee', node.expression);
      argumentsOf(sf, node, add);
    }
    if (ts.isNewExpression(node)) argumentsOf(sf, node, add);
    if (ts.isReturnStatement(node) && node.expression) add('returnExpression', node.expression);
    if (ts.isExpressionStatement(node) && !ts.isCallExpression(node.expression) && !ts.isAwaitExpression(node.expression)) add('statement', node.expression);
    if (ts.isJsxExpression(node) && node.expression && ts.isBinaryExpression(node.expression) && node.expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) add('condition', node.expression.left);
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) add('returnExpression', node.body);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out.toSorted((a, b) => a.start - b.start || b.end - a.end);
}

/** `throw new XError(...)` or `throw new XException(...)`, directly. */
function isThrownError(node: ts.Node): node is ts.NewExpression {
  if (!ts.isNewExpression(node) || !ts.isThrowStatement(node.parent)) return false;
  const callee = node.expression;
  if (ts.isPropertyAccessExpression(callee)) return /(Error|Exception)$/.test(callee.name.text);
  return ts.isIdentifier(callee) && /(Error|Exception)$/.test(callee.text);
}

/** `f` or `a.b.f`: a chain through another call (`a.filter(...).map`) is that call's fragment, not a target to swap. */
function isPlainCallee(e: ts.Expression): boolean {
  if (ts.isIdentifier(e) || e.kind === ts.SyntaxKind.ThisKeyword) return true;
  return ts.isPropertyAccessExpression(e) && isPlainCallee(e.expression);
}

function argumentsOf(sf: ts.SourceFile, node: ts.CallExpression | ts.NewExpression, add: (kind: PlaceholderKind, node: ts.Node, start?: number, end?: number) => void): void {
  const args = node.arguments;
  if (!args || args.length === 0) return;
  add('callArguments', node, args[0]!.getStart(sf), args.at(-1)!.getEnd());
}

/** The text between a loop's parentheses, without surrounding whitespace; none for `for (;;)`. */
function headerOf(sf: ts.SourceFile, node: ts.ForStatement | ts.ForOfStatement | ts.ForInStatement): { start: number; end: number } | undefined {
  if (ts.isForStatement(node) && !node.initializer && !node.condition && !node.incrementor) return undefined;
  const children = node.getChildren(sf);
  const open = children.find((c) => c.kind === ts.SyntaxKind.OpenParenToken);
  const close = children.find((c) => c.kind === ts.SyntaxKind.CloseParenToken);
  if (!open || !close) return undefined;
  const inner = sf.text.slice(open.getEnd(), close.getStart(sf));
  const start = open.getEnd() + (inner.length - inner.trimStart().length);
  const end = close.getStart(sf) - (inner.length - inner.trimEnd().length);
  return end > start ? { start, end } : undefined;
}

function found(sf: ts.SourceFile, s: Span): FoundPlaceholder {
  const p = { kind: s.kind, start: positionOf(sf, s.start), end: positionOf(sf, s.end), original: sf.text.slice(s.start, s.end), scope: scopeOf(s.node) };
  return holdsFunctionOrJsx(s) ? { ...p, wide: true } : p;
}

/** A function or a JSX element inside the span: such a fragment is too big to rewrite for one changed line. */
function holdsFunctionOrJsx(s: Span): boolean {
  const inside = (n: ts.Node): boolean => {
    if (n.getStart() >= s.start && n.getEnd() <= s.end && (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n))) return true;
    return ts.forEachChild(n, inside) ?? false;
  };
  return inside(s.node);
}

function positionOf(sf: ts.SourceFile, offset: number): Position {
  const lc = sf.getLineAndCharacterOfPosition(offset);
  return { line: lc.line + 1, column: lc.character + 1 };
}

function offsetOf(sf: ts.SourceFile, p: Position): number | undefined {
  const starts = sf.getLineStarts();
  if (p.line < 1 || p.line > starts.length) return undefined;
  const offset = starts[p.line - 1]! + p.column - 1;
  return offset <= sf.text.length ? offset : undefined;
}
