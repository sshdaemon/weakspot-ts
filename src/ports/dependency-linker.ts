/** Gives a second checkout of a repository the dependencies installed in the first. */
export interface DependencyLinker {
  /** Links each package's installed dependencies from `mainRoot` into the same package in `treeRoot`. Returns the package dirs wired, repo-relative. */
  link(mainRoot: string, treeRoot: string): string[];
}
