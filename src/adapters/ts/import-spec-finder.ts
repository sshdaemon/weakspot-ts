import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { repoRelative } from '../../change/paths.ts';
import type { Package, SpecSet } from '../../change/types.ts';
import type { ImportsReader, SpecFinder } from '../../ports/spec-finder.ts';
import { DEFAULT_SPEC_PATTERNS, isAnySpec, isE2eSpec, isUnitSpec, type SpecPatterns } from '../../change/spec-kind.ts';

const SOURCE = /\.(ts|tsx|mts|cts)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', 'coverage', '.git', '.turbo']);

/** What a file asks for by specifier: a pure function of its text, so it is cached by content hash. */
interface Specifiers {
  readonly imports: readonly string[];
  readonly mocked: readonly string[];
}

/** Bumped whenever `extractSpecifiers` changes what it returns, so old parses are not served. */
const CACHE_VERSION = 2;

/**
 * One package's parsed specifiers on disk, keyed by file content hash, per finder kind (each kind
 * reads a different set of files); holds only the files seen in the last run.
 */
class SpecifierCache {
  private readonly file: string | undefined;
  private readonly before: Record<string, Specifiers>;
  private readonly seen: Record<string, Specifiers> = {};
  parsed = 0;

  /** `packageKey` names the package across checkouts of one repository, so a worktree shares its checkout's cache. */
  constructor(cacheDir: string | undefined, packageKey: string, kind: string) {
    this.file = cacheDir && path.join(cacheDir, 'specifiers', `v${CACHE_VERSION}-${kind}-${createHash('sha1').update(packageKey).digest('hex').slice(0, 16)}.json`);
    this.before = this.file ? readJson(this.file) : {};
  }

  get(file: string, text: string): Specifiers {
    const key = createHash('sha1').update(file.endsWith('x') ? 'tsx\0' : 'ts\0').update(text).digest('hex');
    let found = this.seen[key] ?? this.before[key];
    if (!found) {
      found = extractSpecifiers(file, text);
      this.parsed++;
    }
    this.seen[key] = found;
    return found;
  }

  /** Written to a temporary file and renamed, so a concurrent run never reads half a file. */
  save(): void {
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.seen));
    renameSync(tmp, this.file);
  }
}

/** The cached entries, or none when the file is missing, unreadable or not in the expected shape. */
function readJson(file: string): Record<string, Specifiers> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const ok = Object.values(raw).every((v) => v && typeof v === 'object' && isStrings((v as Specifiers).imports) && isStrings((v as Specifiers).mocked));
  return ok ? (raw as Record<string, Specifiers>) : {};
}

function isStrings(v: unknown): boolean {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

interface Resolver {
  readonly options: ts.CompilerOptions;
  readonly cache: ts.ModuleResolutionCache;
  readonly specifiers: SpecifierCache;
}

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
 * is read once per run. `kind` says which specs count: unit specs (the unit lane) or e2e specs
 * (an `imports` source in a later lane); the other kind is left out of the graph either way.
 * Parsed specifiers are cached on disk under `cacheDir` by file content; resolution is cached for
 * the run only, since it depends on which files exist.
 */
export class ImportSpecFinder implements SpecFinder, ImportsReader {
  private readonly depth: number;
  private readonly patterns: SpecPatterns;
  private readonly kind: 'unit' | 'e2e';
  private readonly cacheDir: string | undefined;
  private readonly cacheScope: string | undefined;
  private readonly indexes = new Map<string, PackageIndex>();
  private readonly resolvers = new Map<string, Resolver>();

  /** With `cacheScope` (the repository's key), the cache is per repository and package path, shared by its checkouts and worktrees; without it, per package folder. */
  constructor(depth = 1, patterns: SpecPatterns = DEFAULT_SPEC_PATTERNS, kind: 'unit' | 'e2e' = 'unit', cacheDir?: string, cacheScope?: string) {
    this.depth = depth;
    this.patterns = patterns;
    this.kind = kind;
    this.cacheDir = cacheDir;
    this.cacheScope = cacheScope;
  }

  /** Files parsed in this run rather than read from the cache, per package dir; for tests and the report. */
  parsedCount(pkg: Package): number {
    return this.resolvers.get(pkg.dir)?.specifiers.parsed ?? 0;
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
    const specs = [...found].map((s) => repoRelative(realRoot, s)).toSorted();
    return { file, specs, how: specs.length > 0 ? 'imports' : 'none' };
  }

  /** Sources a spec imports, resolved, given back under the package's logical path; for the changed-spec rule. */
  importsOf(repoRoot: string, pkg: Package, absSpec: string): string[] {
    const realRoot = realpathSafe(repoRoot);
    const realPkg = realpathSafe(pkg.dir);
    return resolveImports(absSpec, this.resolverFor(realRoot, pkg))
      .imports.filter((p) => !isAnySpec(repoRelative(realRoot, p), this.patterns))
      .map((p) => (p === realPkg || p.startsWith(realPkg + path.sep) ? path.join(pkg.dir, path.relative(realPkg, p)) : p));
  }

  importLines(absSpec: string): ReadonlySet<number> {
    let text: string;
    try {
      text = readFileSync(absSpec, 'utf8');
    } catch {
      return new Set();
    }
    const sf = ts.createSourceFile(absSpec, text, ts.ScriptTarget.Latest, false, absSpec.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const lines = new Set<number>();
    text.split('\n').forEach((l, i) => {
      if (!l.trim()) lines.add(i + 1);
    });
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) && !ts.isImportEqualsDeclaration(st)) continue;
      const first = sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1;
      const last = sf.getLineAndCharacterOfPosition(st.getEnd()).line + 1;
      for (let l = first; l <= last; l++) lines.add(l);
    }
    return lines;
  }

  onlyImports(text: string): boolean {
    const sf = ts.createSourceFile('removed.ts', text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    const broken = (sf as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics ?? [];
    return broken.length === 0 && sf.statements.every((st) => ts.isImportDeclaration(st) || ts.isImportEqualsDeclaration(st));
  }

  /** Spec patterns are matched on the repo-relative path, as triage does, so anchored patterns agree. */
  private indexFor(realRoot: string, pkg: Package): PackageIndex {
    let index = this.indexes.get(pkg.dir);
    if (index) return index;
    const resolver = this.resolverFor(realRoot, pkg);
    const importers = new Map<string, Set<string>>();
    const specs = new Set<string>();
    const mocks = new Map<string, Set<string>>();
    for (const file of listSources(realpathSafe(pkg.dir))) {
      const rel = repoRelative(realRoot, file);
      if (this.kind === 'unit' ? isUnitSpec(rel, this.patterns) : isE2eSpec(rel, this.patterns)) specs.add(file);
      else if (isAnySpec(rel, this.patterns)) continue;
      const resolved = resolveImports(file, resolver);
      if (resolved.mocked.size > 0) mocks.set(file, resolved.mocked);
      for (const imported of resolved.imports) {
        let set = importers.get(imported);
        if (!set) importers.set(imported, (set = new Set()));
        set.add(file);
      }
    }
    resolver.specifiers.save();
    index = { importers, specs, mocks };
    this.indexes.set(pkg.dir, index);
    return index;
  }

  private resolverFor(realRoot: string, pkg: Package): Resolver {
    let resolver = this.resolvers.get(pkg.dir);
    if (!resolver) {
      const options = compilerOptions(pkg);
      const cache = ts.createModuleResolutionCache(pkg.dir, (f) => (ts.sys.useCaseSensitiveFileNames ? f : f.toLowerCase()), options);
      const packageKey = this.cacheScope === undefined ? pkg.dir : `${this.cacheScope}\0${repoRelative(realRoot, realpathSafe(pkg.dir))}`;
      resolver = { options, cache, specifiers: new SpecifierCache(this.cacheDir, packageKey, this.kind) };
      this.resolvers.set(pkg.dir, resolver);
    }
    return resolver;
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
 * specifier, resolved to source files. Modules the file passes to `vi.mock`/`vi.doMock` are
 * resolved the same way, removed from the imports and returned as `mocked`: a spec that replaces a
 * module does not test it, whatever specifier it used.
 */
function resolveImports(file: string, resolver: Resolver): { imports: string[]; mocked: Set<string> } {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { imports: [], mocked: new Set() };
  }
  const found = resolver.specifiers.get(file, text);
  const resolve = (spec: string): string | undefined => {
    const resolved = ts.resolveModuleName(spec, file, resolver.options, ts.sys, resolver.cache).resolvedModule;
    if (!resolved || resolved.isExternalLibraryImport || !SOURCE.test(resolved.resolvedFileName) || resolved.resolvedFileName.endsWith('.d.ts')) return undefined;
    return realpathSafe(resolved.resolvedFileName);
  };
  const mocked = new Set(found.mocked.map(resolve).filter((r): r is string => r !== undefined));
  const imports = found.imports.map(resolve).filter((r): r is string => r !== undefined && !mocked.has(r));
  return { imports, mocked };
}

/** The specifiers a file imports and mocks. Type-only imports are skipped: they are erased at runtime. */
function extractSpecifiers(file: string, text: string): Specifiers {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const imports = new Set<string>();
  const mocked = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!isTypeOnlyImport(node)) imports.add(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!isTypeOnlyExport(node)) imports.add(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      const callee = node.expression;
      const specifier = node.arguments[0].text;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) imports.add(specifier);
      else if (ts.isIdentifier(callee) && callee.text === 'require') imports.add(specifier);
      else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'vi') {
        if (callee.name.text === 'importActual') imports.add(specifier);
        else if (callee.name.text === 'mock' || callee.name.text === 'doMock') mocked.add(specifier);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { imports: [...imports], mocked: [...mocked] };
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
