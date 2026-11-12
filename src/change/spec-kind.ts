/** Which file names are unit specs and which are end-to-end specs. Both configurable; these are the defaults. */
export interface SpecPatterns {
  readonly specPattern: string;
  readonly e2ePattern: string;
}

export const DEFAULT_SPEC_PATTERNS: SpecPatterns = {
  specPattern: '\\.(spec|test)\\.(ts|tsx|mts|cts)$',
  e2ePattern: '\\.(e2e-spec|e2e|integration)\\.(ts|tsx|mts|cts)$',
};

/** A unit spec: matches the spec pattern and not the e2e pattern. */
export function isUnitSpec(path: string, patterns: SpecPatterns): boolean {
  return new RegExp(patterns.specPattern).test(path) && !new RegExp(patterns.e2ePattern).test(path);
}

/** An end-to-end spec: matches the e2e pattern. */
export function isE2eSpec(path: string, patterns: SpecPatterns): boolean {
  return new RegExp(patterns.e2ePattern).test(path);
}

export function isAnySpec(path: string, patterns: SpecPatterns): boolean {
  return new RegExp(patterns.specPattern).test(path) || new RegExp(patterns.e2ePattern).test(path);
}
