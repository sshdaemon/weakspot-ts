import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { Mutant } from '../../mutation/types.ts';
import type { MutantSite, SourceInspector } from '../../ports/source-inspector.ts';
import type { NoiseClass } from '../../report/types.ts';

const LOG_METHODS = new Set(['log', 'debug', 'info', 'warn', 'error', 'trace', 'verbose', 'fatal']);
const STYLE_ATTRIBUTES = new Set(['className', 'class', 'style']);

/**
 * Finds the innermost node holding each mutant. Its noise class comes from the nearest ancestor that
 * defines one: a logging call; the message of an error that is thrown directly; a catch block that
 * only logs or rethrows; a literal JSX attribute value or a class or style expression. Handlers,
 * render conditions, other catch logic and other constructor arguments are not noise.
 */
export class TsSourceInspector implements SourceInspector {
  inspect(absFile: string, mutants: readonly Mutant[]): Map<string, MutantSite> {
    const out = new Map<string, MutantSite>();
    let text: string;
    try {
      text = readFileSync(absFile, 'utf8');
    } catch {
      return out;
    }
    const sf = ts.createSourceFile(absFile, text, ts.ScriptTarget.Latest, true, /\.[cm]?tsx$|\.jsx$/.test(absFile) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    for (const m of mutants) {
      const start = positionOf(sf, m.start);
      const end = positionOf(sf, m.end);
      if (start === undefined || end === undefined) continue;
      const node = innermost(sf, start, end);
      const noise = noiseAt(node, start);
      out.set(m.id, noise ? { noise, scope: scopeOf(node) } : { scope: scopeOf(node) });
    }
    return out;
  }
}

function positionOf(sf: ts.SourceFile, p: { line: number; column: number }): number | undefined {
  if (p.line < 1 || p.line > sf.getLineStarts().length) return undefined;
  return sf.getPositionOfLineAndCharacter(p.line - 1, p.column - 1);
}

function innermost(sf: ts.SourceFile, start: number, end: number): ts.Node {
  let node: ts.Node = sf;
  for (;;) {
    const child = node.getChildren(sf).find((c) => c.getStart(sf) <= start && end <= c.getEnd());
    if (!child) return node;
    node = child;
  }
}

function noiseAt(node: ts.Node, start: number): NoiseClass | undefined {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    // A function is where behaviour lives: nothing inside a handler or callback is noise for being in an attribute.
    if (ts.isFunctionLike(n) && !ts.isSourceFile(n)) return insideCallOrCatch(n, start);
    if (ts.isJsxAttribute(n)) return isStyleAttribute(n, start) ? 'jsxAttribute' : undefined;
    const found = callOrCatchNoise(n, start);
    if (found) return found;
  }
  return undefined;
}

/** Inside a function, only logging calls and report-only catch blocks around it still count. */
function insideCallOrCatch(fn: ts.Node, start: number): NoiseClass | undefined {
  for (let n: ts.Node | undefined = fn; n; n = n.parent) {
    if (ts.isCallExpression(n) && isLoggingCall(n)) return 'logging';
    if (ts.isCatchClause(n) && n.block.getStart() <= start && reportsOnly(n)) return 'catchOnly';
  }
  return undefined;
}

function callOrCatchNoise(n: ts.Node, start: number): NoiseClass | undefined {
  if (ts.isCallExpression(n) && isLoggingCall(n)) return 'logging';
  if (ts.isNewExpression(n) && isThrownError(n) && isFirstArgument(n, start)) return 'errorMessage';
  if (ts.isCatchClause(n) && n.block.getStart() <= start && reportsOnly(n)) return 'catchOnly';
  return undefined;
}

/** A literal value (`title="..."`, `title={'...'}`, a template) or any expression in className, class or style. */
function isStyleAttribute(attr: ts.JsxAttribute, start: number): boolean {
  if (STYLE_ATTRIBUTES.has(attr.name.getText())) return true;
  const init = attr.initializer;
  if (!init) return false;
  if (ts.isStringLiteral(init)) return true;
  const expr = ts.isJsxExpression(init) ? init.expression : undefined;
  return Boolean(expr && expr.getStart() <= start && (ts.isStringLiteralLike(expr) || ts.isTemplateExpression(expr)));
}

/** `throw new XError(...)`, directly. */
function isThrownError(n: ts.NewExpression): boolean {
  return isErrorName(n.expression) && ts.isThrowStatement(n.parent);
}

function isFirstArgument(n: ts.NewExpression, start: number): boolean {
  const first = n.arguments?.[0];
  return Boolean(first && first.getStart() <= start && start < first.getEnd());
}

/** Every statement logs or rethrows the caught error itself: the catch reports and changes nothing. A new error is behaviour. */
function reportsOnly(clause: ts.CatchClause): boolean {
  const binding = clause.variableDeclaration?.name;
  const caught = binding && ts.isIdentifier(binding) ? binding.text : undefined;
  const isRethrow = (st: ts.Statement) => ts.isThrowStatement(st) && caught !== undefined && ts.isIdentifier(st.expression) && st.expression.text === caught;
  const statements = clause.block.statements;
  return statements.length > 0 && statements.every((st) => isLoggingStatement(st) || isRethrow(st));
}

function isLoggingStatement(st: ts.Statement): boolean {
  return ts.isExpressionStatement(st) && ts.isCallExpression(st.expression) && isLoggingCall(st.expression);
}

/** `console.x(...)`, `<log or logger>.<level>(...)`, or a bare `log(...)`. */
export function isLoggingCall(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text === 'log';
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const targetName = nameOf(callee.expression);
  if (targetName === 'console') return true;
  return /^(log|logger)$/i.test(targetName) && LOG_METHODS.has(callee.name.text);
}

function isErrorName(e: ts.Expression): boolean {
  return /(Error|Exception)$/.test(nameOf(e));
}

/** `x` for `x` and for `a.b.x`; empty for anything else. */
function nameOf(e: ts.Expression): string {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return '';
}

/** Named functions and classes around the node, outermost first; an unnamed function takes the name it is assigned to. */
export function scopeOf(node: ts.Node): string {
  const names: string[] = [];
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    const name = declaredName(n);
    if (name) names.unshift(name);
  }
  return names.join('.');
}

function declaredName(n: ts.Node): string | undefined {
  if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isMethodDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n)) && n.name) return n.name.getText();
  if (ts.isConstructorDeclaration(n)) return 'constructor';
  if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isClassExpression(n)) && n.parent) {
    const p = n.parent;
    if ((ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) && p.name) return p.name.getText();
  }
  return undefined;
}
