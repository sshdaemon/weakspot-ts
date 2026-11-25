import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { isInside } from '../../change/paths.ts';
import type { PullRequest, PullRequestCheckout } from '../../ports/pull-request-source.ts';
import { changedLockfiles } from '../../change/lockfiles.ts';
import { checkTop, GitError, ownerAndName } from './git-change-source.ts';

/** Plain git: `fetch` from origin, `diff --name-only`, `worktree add --detach` and `worktree remove`. */
export class GitPullRequestCheckout implements PullRequestCheckout {
  originRepo(repoRoot: string): string | undefined {
    let url: string;
    try {
      url = git(repoRoot, ['remote', 'get-url', 'origin']).trim();
    } catch {
      return undefined;
    }
    return ownerAndName(url);
  }

  fetch(repoRoot: string, pr: PullRequest): void {
    git(repoRoot, ['fetch', '--quiet', '--no-tags', 'origin', `refs/pull/${pr.number}/head`, `refs/heads/${pr.baseRef}`], `could not fetch pull request ${pr.number} and ${pr.baseRef} from origin`);
    for (const [what, sha] of [['head', pr.headSha], ['base', pr.baseSha]] as const) {
      try {
        git(repoRoot, ['cat-file', '-e', `${sha}^{commit}`]);
      } catch {
        throw new GitError(`pull request ${pr.number} moved since it was read: its ${what} ${sha.slice(0, 12)} is not on origin any more; run again`);
      }
    }
  }

  checkTop(repoRoot: string): void {
    checkTop(repoRoot, (args) => git(repoRoot, args));
  }

  lockfileDrift(repoRoot: string, sha: string): string[] {
    const tracked = git(repoRoot, ['-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', sha]).split('\n').filter(Boolean);
    return changedLockfiles(tracked).filter((file) => {
      const installed = path.join(repoRoot, file);
      return !existsSync(installed) || !readFileSync(installed).equals(execFileSync('git', ['show', `${sha}:${file}`], { cwd: repoRoot, maxBuffer: 1 << 30 }));
    });
  }

  add(repoRoot: string, dir: string, sha: string): boolean {
    if (existsSync(dir) && this.list(repoRoot, dir).length > 0) {
      const edited = git(dir, ['-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=no']).split('\n').map((l) => l.slice(3)).filter(Boolean);
      if (edited.length > 0) throw new GitError(`the kept worktree ${dir} has edits: ${edited.join(', ')}; save what you need from it, then run weakspot pr --clean`);
      if (git(dir, ['rev-parse', 'HEAD']).trim() === sha) return true;
    }
    if (existsSync(dir)) this.remove(repoRoot, dir);
    git(repoRoot, ['worktree', 'add', '--quiet', '--detach', dir, sha], `could not make a worktree for ${sha.slice(0, 12)} in ${dir}`);
    return false;
  }

  remove(repoRoot: string, dir: string): void {
    try {
      git(repoRoot, ['worktree', 'remove', '--force', dir]);
    } catch {
      // not this checkout's worktree any more (a fresh clone, a deleted checkout): the folder is ours to drop
      rmSync(dir, { recursive: true, force: true });
    }
    git(repoRoot, ['worktree', 'prune']);
  }

  list(repoRoot: string, under: string): string[] {
    const root = existsSync(under) ? realpathSync(under) : path.resolve(under);
    return git(repoRoot, ['worktree', 'list', '--porcelain'])
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length))
      .filter((dir) => isInside(root, existsSync(dir) ? realpathSync(dir) : dir));
  }
}

function git(cwd: string, args: string[], failure?: string): string {
  try {
    // A full ls-tree of a large monorepo is several MB; git's own default buffer would cut it off.
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim().split('\n').at(-1) ?? '';
    throw new GitError(failure ? `${failure}: ${stderr}` : `git ${args.join(' ')} failed: ${stderr}`);
  }
}
