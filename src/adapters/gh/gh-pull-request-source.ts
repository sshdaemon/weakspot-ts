import { execFileSync } from 'node:child_process';
import type { PullRequest, PullRequestSource } from '../../ports/pull-request-source.ts';

/** gh is missing, not signed in, or the pull request cannot be read: nothing ran. */
export class PullRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PullRequestError';
  }
}

type Run = (args: readonly string[], cwd: string) => string;

const runGh: Run = (args, cwd) => execFileSync('gh', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** `gh pr view` in the checkout, so a bare number means a pull request of the repository gh picks for it. */
export class GhPullRequestSource implements PullRequestSource {
  private readonly run: Run;

  constructor(run: Run = runGh) {
    this.run = run;
  }

  describe(repoRoot: string, ref: string): PullRequest {
    let text: string;
    try {
      text = this.run(['pr', 'view', ref, '--json', 'number,url,headRefOid,baseRefName,baseRefOid'], repoRoot);
    } catch (err) {
      const e = err as { code?: string; stderr?: string; message?: string };
      if (e.code === 'ENOENT') throw new PullRequestError('gh is not installed; weakspot pr reads pull requests through the GitHub CLI');
      throw new PullRequestError(`gh could not read pull request ${ref}: ${(e.stderr ?? e.message ?? '').toString().trim().split('\n')[0]}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new PullRequestError(`gh gave an unexpected answer for pull request ${ref}`);
    }
    return pullRequestOf(raw, ref);
  }
}

const sha = (v: unknown): string | undefined => (typeof v === 'string' && /^[0-9a-f]{40}$/.test(v) ? v : undefined);

/** The fields weakspot needs, checked; the repository comes from the URL. Exported for its unit test. */
export function pullRequestOf(raw: unknown, ref: string): PullRequest {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const m = /^https:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+$/.exec(String(o['url'] ?? ''));
  const headSha = sha(o['headRefOid']);
  const baseSha = sha(o['baseRefOid']);
  const baseRef = o['baseRefName'];
  const number = o['number'];
  if (!m || typeof number !== 'number' || !headSha || !baseSha || typeof baseRef !== 'string' || !baseRef) throw new PullRequestError(`gh gave an unexpected answer for pull request ${ref}`);
  return { number, url: String(o['url']), repo: m[1]!, headSha, baseRef, baseSha };
}
