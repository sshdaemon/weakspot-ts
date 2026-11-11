import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { repoRelative } from '../../change/paths.ts';
import type { Package, SpecSet } from '../../change/types.ts';
import type { ImportsReader, SpecFinder } from '../../ports/spec-finder.ts';
import { DEFAULT_SPEC_PATTERNS, isAnySpec, isUnitSpec, type SpecPatterns } from '../../change/spec-kind.ts';

const SOURCE = /\.(ts|tsx|mts|cts)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', 'coverage', '.git', '.turbo']);

interface PackageIndex {
  /** Absolute importer paths per absolute imported file. */
  readonly importers: Map<string, Set<string>>;
  readonly specs: Set<string>;
  /** Per spec, the resolved files it replaces with `vi.mock`: that spec never runs their code. */
  readonly mocks: Map<string, Set<string>>;
}

/**
 * Finds the specs that reach a file through imports, resolved with the TypeScript compiler API
 * against the package's tsconfig (so `paths` aliases and workspace packages resolve). Depth 1 is
 * a spec importing the file; depth 2 allows one intermediate module. The package's import graph
 * is read once per run.
 */
export class ImportSpecFinder implements SpecFinder, ImportsReader {
  private readonly depth: number;
  private readonly patterns: SpecPatterns;
  private readonly indexes = new Map<string, PackageIndex>();

  constructor(depth = 1, patterns: SpecPatterns = DEFAULT_SPEC_PATTERNS) {
    this.depth = depth;
    this.patterns = patterns;
  }

  find(repoRoot: string, pkg: Package, file: string, explicit: readonly string[]): SpecSet {
    if (explicit.length > 0) return { file, specs: [...explicit], how: 'explicit' };
    // The resolver returns real paths (macOS: /var is /private/var), so compare real to real.
    const realRoot = realpathSafe(repoRoot);
    const index = this.indexFor(realRoot, pkg);
    const target = realpathSafe(path.join(repoRoot, file));
    const found = new Set<string>();
    let frontier = new Set<string>([target]);
    const seen = new Set<string>([target]);
    for (let d = 0; d < this.depth && frontier.size > 0; d++) {
      const next = new Set<string>();
      for (const f of frontier) {
        for (const importer of index.importers.get(f) ?? []) {
          if (index.specs.has(importer)) {
            // A spec reaching the target through an intermediate module still mocks it away.
            if (!index.mocks.get(importer)?.has(target)) found.add(importer);
          } else if (!seen.has(importer)) {
            seen.add(importer);
            next.add(importer);
          }
        }
      }
      frontier = next;
    }
    const specs = [...found].map((s) => repoRelative(realRoot, s)).sort();
    return { file, specs, how: specs.length > 0 ? 'imports' : 'none' };
  }

  /** Sources a spec imports, resolved, given back under the package's logical path; for the changed-spec rule. */
  importsOf(repoRoot: string, pkg: Package, absSpec: string): string[] {
    const options = compilerOptions(pkg);
    const realRoot = realpathSafe(repoRoot);
    const realPkg = realpathSafe(pkg.dir);
    return resolveImports(absSpec, options)
      .imports.filter((p) => !isAnySpec(repoRelative(realRoot, p), this.patterns))
      .map((p) => (p === realPkg || p.startsWith(realPkg + path.sep) ? path.join(pkg.dir, path.relative(realPkg, p)) : p));
  }

  /** Spec patterns are matched on the repo-relative path, as triage does, so anchored patterns agree. */
  private indexFor(realRoot: string, pkg: Package): PackageIndex {
    let index = this.indexes.get(pkg.dir);
    if (index) return index;
    const options = compilerOptions(pkg);
    const importers = new Map<string, Set<string>>();
    const specs = new Set<string>();
    const mocks = new Map<string, Set<string>>();
    for (const file of listSources(realpathSafe(pkg.dir))) {
      const rel = repoRelative(realRoot, file);
      if (isUnitSpec(rel, this.patterns)) specs.add(file);
      else if (isAnySpec(rel, this.patterns)) continue;
      const resolved = resolveImports(file, options);
      if (resolved.mocked.size > 0) mocks.set(file, resolved.mocked);
      for (const imported of resolved.imports) {
        let set = importers.get(imported);
        if (!set) importers.set(imported, (set = new Set()));
        set.add(file);
      }
    }
    index = { importers, specs, mocks };
    this.indexes.set(pkg.dir, index);
    return index;
  }
}

function compilerOptions(pkg: Package): ts.CompilerOptions {
  const configPath = ts.findConfigFile(pkg.dir, ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) return { moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: false };
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, path.dirname(configPath));
  return { ...parsed.options, noEmit: true };
}

/**
 * Static imports, re-exports, `import()`, `require()` and `vi.importActual()` with a literal
 * specifier, resolved to source files. Type-only imports are skipped (erased at runtime). Modules
 * the file passes to `vi.mock`/`vi.doMock` are resolved the same way, removed from the imports and
 * returned as `mocked`: a spec that replaces a module does not test it, whatever specifier it used.
 */
function resolveImports(file: string, options: ts.CompilerOptions): { imports: string[]; mocked: Set<string> } {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { imports: [], mocked: new Set() };
  }
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const specifiers = new Set<string>();
  const mocked = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!isTypeOnlyImport(node)) specifiers.add(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!isTypeOnlyExport(node)) specifiers.add(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      const callee = node.expression;
      const text = node.arguments[0].text;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) specifiers.add(text);
      else if (ts.isIdentifier(callee) && callee.text === 'require') specifiers.add(text);
      else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'vi') {
        if (callee.name.text === 'importActual') specifiers.add(text);
        else if (callee.name.text === 'mock' || callee.name.text === 'doMock') mocked.add(text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const resolve = (spec: string): string | undefined => {
    const resolved = ts.resolveModuleName(spec, file, options, ts.sys).resolvedModule;
    if (!resolved || resolved.isExternalLibraryImport || !SOURCE.test(resolved.resolvedFileName) || resolved.resolvedFileName.endsWith('.d.ts')) return undefined;
    return realpathSafe(resolved.resolvedFileName);
  };
  const mockedFiles = new Set<string>();
  for (const m of mocked) {
    const r = resolve(m);
    if (r) mockedFiles.add(r);
  }
  const imports: string[] = [];
  for (const spec of specifiers) {
    const r = resolve(spec);
    if (r && !mockedFiles.has(r)) imports.push(r);
  }
  return { imports, mocked: mockedFiles };
}

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return false; // side-effect import `import './x'` runs the module
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  if (!clause.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0) {
    return bindings.elements.every((e) => e.isTypeOnly);
  }
  return false;
}

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  return Boolean(clause && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((e) => e.isTypeOnly));
}

function realpathSafe(p: string): string {
  try {
    return ts.sys.realpath ? ts.sys.realpath(p) : p;
  } catch {
    return p;
  }
}

function listSources(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
      } else if (SOURCE.test(e.name) && !e.name.endsWith('.d.ts')) {
        out.push(p);
      }
    }
  };
  if (statSync(dir).isDirectory()) walk(dir);
  return out;
}
