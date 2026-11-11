import { DEFAULT_SPEC_PATTERNS, isAnySpec, type SpecPatterns } from './spec-kind.ts';
import type { ChangedFile, FileClass, TriageDecision } from './types.ts';

/** Paths that hold no logic worth mutating. Regexes on the repo-relative path. */
export const DEFAULT_SKIP: readonly string[] = [
  '\\.(dto|entity|module|controller|enum|types|constants|config|interface|schema|migration|stories)\\.tsx?$',
  '(^|/)(index|main)\\.ts$',
  '\\.d\\.ts$',
  '(^|/)migrations/',
  '(^|/)__generated__/',
  '(^|/)(test|tests|__tests__|__mocks__)/',
];

export function classify(path: string): FileClass {
  return path.endsWith('.tsx') ? 'component' : 'logic';
}

/** Specs are dropped by the configured spec patterns, everything else by the skip patterns. */
export function triage(files: readonly ChangedFile[], skip: readonly string[] = DEFAULT_SKIP, patterns: SpecPatterns = DEFAULT_SPEC_PATTERNS): TriageDecision[] {
  const skipPatterns = skip.map((s) => new RegExp(s));
  return files.map((file) => {
    const fileClass = classify(file.path);
    if (!/\.(ts|tsx)$/.test(file.path)) {
      return { file, kept: false, fileClass, reason: 'not a TypeScript file' };
    }
    if (isAnySpec(file.path, patterns)) return { file, kept: false, fileClass, reason: 'spec file' };
    const hit = skipPatterns.find((p) => p.test(file.path));
    if (hit) return { file, kept: false, fileClass, reason: `matches skip pattern ${hit.source}` };
    return { file, kept: true, fileClass, reason: '' };
  });
}
