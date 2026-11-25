/** A pull request as the forge describes it, pinned to the commits it had when read. */
export interface PullRequest {
  readonly number: number;
  readonly url: string;
  /** `owner/name` of the repository the pull request is in. */
  readonly repo: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly baseSha: string;
}

/** Reads a pull request by number or URL. GitHub through the gh CLI today. */
export interface PullRequestSource {
  describe(repoRoot: string, ref: string): PullRequest;
}

/** The local git work for a pull request: fetch its commits, list its paths, and give it a worktree of its own. */
export interface PullRequestCheckout {
  /** `owner/name` of the checkout's origin, or undefined when it has none a forge would know. */
  originRepo(repoRoot: string): string | undefined;
  /** Fetches the pull request's head and base so both commits exist locally. */
  fetch(repoRoot: string, pr: PullRequest): void;
  /** Refuses a path that is not the top of its checkout. */
  checkTop(repoRoot: string): void;
  /** Lockfiles at `sha` that differ from the files installed in the checkout, or are missing there. */
  lockfileDrift(repoRoot: string, sha: string): string[];
  /** A detached worktree at `sha` in `dir`; one already there at that commit is reused (returns true). A kept one with edits is refused. */
  add(repoRoot: string, dir: string, sha: string): boolean;
  /** Removes the worktree, or a folder left where one was. */
  remove(repoRoot: string, dir: string): void;
  /** Worktrees of the checkout that live under `under`. */
  list(repoRoot: string, under: string): string[];
}
