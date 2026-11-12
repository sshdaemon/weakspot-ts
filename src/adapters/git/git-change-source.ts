import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { parseUnifiedDiff } from '../../change/hunks.ts';
import type { ChangedFile } from '../../change/types.ts';
import type { ChangeQuery, ChangeSource } from '../../ports/change-source.ts';

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
}

/** Local git: the diff from the merge base with HEAD to the chosen scope, plus untracked files. */
export class GitChangeSource implements ChangeSource {
  changes(q: ChangeQuery): ChangedFile[] {
    const top = realpathSync(this.git(q.repoRoot, ['rev-parse', '--show-toplevel']).trim());
    if (top !== realpathSync(q.repoRoot)) throw new GitError(`${q.repoRoot} is not the top of its git checkout (${top}); git paths are relative to the top, so --repo must point there`);
    const mergeBase = this.git(q.repoRoot, ['merge-base', q.base, 'HEAD'], `no merge base between ${q.base} and HEAD; is ${q.base} fetched?`).trim();
    // Pinned output format: no quoting of non-ASCII paths, fixed a/ b/ prefixes whatever the user's diff
    // config, no external diff driver, no context between hunks (diff.interHunkContext would merge
    // them), explicit rename detection so a moved file yields only its edited lines. GIT_DIFF_OPTS is
    // dropped from the environment below, since it overrides -U0.
    const diffArgs = ['-c', 'core.quotePath=false', 'diff', '-U0', '--inter-hunk-context=0', '--no-color', '--find-renames=50%', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '--diff-filter=AMR'];
    const scopeArgs: Record<ChangeQuery['scope'], string[]> = { committed: [mergeBase, 'HEAD'], staged: ['--cached', mergeBase], working: [mergeBase] };
    const text = this.git(q.repoRoot, [...diffArgs, ...scopeArgs[q.scope]]);
    const files = parseUnifiedDiff(text);
    if (q.scope !== 'working' && files.length > 0) {
      // The engine mutates the working tree, so the ranges must describe it.
      const against = q.scope === 'committed' ? ['HEAD'] : [];
      const dirty = this.git(q.repoRoot, ['--literal-pathspecs', '-c', 'core.quotePath=false', 'diff', '--name-only', ...against, '--', ...files.map((f) => f.path)])
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      if (dirty.length > 0) {
        throw new GitError(`${q.scope} ranges would not match the working tree, which is what gets mutated; these changed files have ${q.scope === 'committed' ? 'uncommitted' : 'unstaged'} edits: ${dirty.join(', ')}`);
      }
    }
    if (q.scope === 'working') {
      const untracked = this.git(q.repoRoot, ['ls-files', '-z', '--others', '--exclude-standard'])
        .split('\0')
        .filter(Boolean);
      for (const path of untracked) files.push({ path, status: 'added', ranges: 'whole' });
    }
    return files;
  }

  defaultBase(repoRoot: string): string | undefined {
    try {
      const ref = this.git(repoRoot, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']).trim();
      if (ref) return ref.replace(/^refs\/remotes\//, '');
    } catch {
      // no origin/HEAD
    }
    return undefined;
  }

  private git(cwd: string, args: string[], failure?: string): string {
    try {
      const env = { ...process.env };
      delete env['GIT_DIFF_OPTS'];
      return execFileSync('git', args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      const detail = err instanceof Error && 'stderr' in err ? String((err as { stderr: unknown }).stderr).trim() : String(err);
      throw new GitError(failure ?? `git ${args.join(' ')} failed: ${detail}`);
    }
  }
}

/** The repository name from the origin URL (`owner/name` -> `name`), for configs shared by every checkout and worktree. */
export function remoteRepoName(repoRoot: string): string | undefined {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = /([^/:]+?)(?:\.git)?\/?$/.exec(url);
    return m?.[1];
  } catch {
    return undefined;
  }
}
