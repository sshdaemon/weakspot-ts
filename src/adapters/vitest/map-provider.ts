// Loaded by Vitest as a custom coverage provider during `weakspot map`. In each worker it keeps V8's
// precise coverage running and, after each spec file, takes the repo files in which a function ran:
// a named function other than a class constructor or a transpiler helper, so loading a module, or a
// dependency container building its classes, does not count. At the end it writes, per spec file,
// those files to the JSON file named by WEAKSPOT_MAP_OUT.
import { writeFileSync } from 'node:fs';
import inspector from 'node:inspector';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The shape of a V8 precise-coverage function entry this provider reads. */
export interface CoveredFunction {
  readonly functionName: string;
  readonly ranges: readonly { readonly count: number }[];
}

// The provider module is loaded again for every isolated spec file; the session belongs to the worker.
const SESSION = Symbol.for('weakspot.map.session');
const holder = globalThis as unknown as Record<symbol, inspector.Session | undefined>;

function post<T>(method: string, params: object = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    holder[SESSION]!.post(method, params, (err, result) => (err ? reject(err) : resolve(result as T)));
  });
}

/** A module body or an export getter: no name. A field initializer: an angle-bracket one. */
const isAnonymous = (name: string): boolean => name === '' || name.startsWith('<');

/** Decorator and class-field helpers a transpiler writes into each file (`_ts_decorate`, `__decorateClass`), called at load. */
const isTranspilerHelper = (name: string): boolean => name.startsWith('_');

/** V8 names a class constructor after its class; in .tsx and .jsx a capitalised function is a component instead. */
const isConstructor = (file: string, name: string): boolean => /^[A-Z]/.test(name) && !/\.[jt]sx$/.test(file);

/** A function of the file ran that loading it, or a container building its classes, does not run on its own. */
export function ranFunction(file: string, functions: readonly CoveredFunction[]): boolean {
  return functions.some(({ functionName: name, ranges }) => (ranges[0]?.count ?? 0) > 0 && !isAnonymous(name) && !isTranspilerHelper(name) && !isConstructor(file, name));
}

interface ProviderContext {
  readonly config: { readonly root: string; readonly coverage: unknown };
}

export default {
  async startCoverage(): Promise<void> {
    if (holder[SESSION]) return;
    const session = new inspector.Session();
    session.connect();
    holder[SESSION] = session;
    await post('Profiler.enable');
    await post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
  },

  /** Taking coverage also resets the counts, so each spec file sees only what it ran. */
  async takeCoverage(): Promise<string[]> {
    if (!holder[SESSION]) return [];
    const { result } = await post<{ result: { url: string; functions: CoveredFunction[] }[] }>('Profiler.takePreciseCoverage');
    return result.filter((s) => s.url.startsWith('file://') && !s.url.includes('/node_modules/')).map((s) => ({ file: fileURLToPath(s.url), functions: s.functions })).filter((s) => ranFunction(s.file, s.functions)).map((s) => s.file);
  },

  getProvider() {
    const bySpec = new Map<string, string[]>();
    let ctx: ProviderContext;
    return {
      name: 'weakspot-map',
      initialize(vitest: ProviderContext): void {
        ctx = vitest;
      },
      resolveOptions(): unknown {
        return ctx.config.coverage;
      },
      clean(): void {},
      onAfterSuiteRun({ coverage, testFiles }: { coverage?: unknown; testFiles: string[] }): void {
        const files = Array.isArray(coverage) ? (coverage as string[]) : [];
        for (const file of testFiles) {
          const spec = path.resolve(ctx.config.root, file);
          bySpec.set(spec, [...new Set([...(bySpec.get(spec) ?? []), ...files])]);
        }
      },
      generateCoverage(): Record<string, string[]> {
        return Object.fromEntries(bySpec);
      },
      reportCoverage(map: Record<string, string[]>): void {
        writeFileSync(process.env['WEAKSPOT_MAP_OUT']!, JSON.stringify(map));
      },
    };
  },
};
