/** A private copy of a package where one file at a time is swapped for a mutant and put back. */
export interface Sandbox {
  /** Absolute path of the copy; the runner starts here. */
  readonly dir: string;
  /** Replaces a package-relative file in the copy. */
  write(file: string, text: string): void;
  /** Puts the package's own version of a file back. */
  restore(file: string): void;
  dispose(): void;
}

export interface SandboxFactory {
  /** Copies `pkgDir` to `at`, which must not exist yet. */
  create(pkgDir: string, at: string): Sandbox;
}
