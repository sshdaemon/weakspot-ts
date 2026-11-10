import type { ChangedFile, FileClass, TriageDecision } from './types.ts';

/** Paths that hold no logic worth mutating. Regexes on the repo-relative path. */
export const DEFAULT_SKIP: readonly string[] = [
  '\\.(dto|entity|module|controller|enum|types|constants|config|interface|schema|migration|stories)\\.tsx?$',
  '(^|/)(index|main)\\.ts$',
  '\\.d\\.ts$',
  '(^|/)migrations/',
  '(^|/)__generated__/',
  '\\.(spec|test|e2e-spec)\\.tsx?$',
];

export function classify(path: string): FileClass {
  return path.endsWith('.tsx') ? 'component' : 'logic';
}

export function triage(files: readonly ChangedFile[], skip: readonly string[] = DEFAULT_SKIP): TriageDecision[] {
  const patterns = skip.map((s) => new RegExp(s));
  return files.map((file) => {
    const fileClass = classify(file.path);
    if (!/\.(ts|tsx)$/.test(file.path)) {
      return { file, kept: false, fileClass, reason: 'not a TypeScript file' };
    }
    const hit = patterns.find((p) => p.test(file.path));
    if (hit) return { file, kept: false, fileClass, reason: `matches skip pattern ${hit.source}` };
    return { file, kept: true, fileClass, reason: '' };
  });
}
