/** The specs fail on the unmutated code, so no mutant can be judged. */
export class TestsFailBeforeMutationError extends Error {
  constructor(pkgName: string, detail: string) {
    super(`tests fail before mutation in ${pkgName}: ${detail}`);
    this.name = 'TestsFailBeforeMutationError';
  }
}

/** A file's specs passed with its sandbox copy made to throw on load: they import the real tree, so no mutant there can be judged. */
export class SandboxNotLoadedError extends Error {
  constructor(files: readonly string[]) {
    super(
      `the specs never loaded the sandbox copy of: ${files.join(', ')}. ` +
        `They passed with that copy replaced by a module that throws on load, which points at an import or alias that resolves to the real tree.`,
    );
    this.name = 'SandboxNotLoadedError';
  }
}
