import { SuppressionStoreError } from '../adapters/fs/suppression-store.ts';
import { PullRequestError } from '../adapters/gh/gh-pull-request-source.ts';
import { GitError } from '../adapters/git/git-change-source.ts';
import { SpecCommandError } from '../adapters/shell/command-spec-finder.ts';
import { PrepareError } from '../adapters/shell/run-command.ts';
import { EngineFailedError } from '../adapters/stryker/stryker-engine.ts';
import { SandboxNotLoadedError, TestsFailBeforeMutationError } from '../mutation/errors.ts';
import { MutantsFileError } from '../mutation/validate.ts';
import { ChangeListError } from '../change/change-list.ts';
import type { Report } from '../report/types.ts';
import { ConfigError } from './config.ts';
import { UnsupportedByRunnerError } from '../adapters/runner-set.ts';
import { MapFailedError } from './map-command.ts';
import { InterruptedError, UninstrumentedError, UsageError } from './pipeline.ts';

/** What `weakspot` exits with. 0 and 1 are completed runs; consumers read the report for both. */
export const EXIT = {
  /** The run completed with no findings. */
  clean: 0,
  /** The run completed with findings in report.json; for `run --check`, some answers were rejected (check-rejected.json). */
  findings: 1,
  /** The command line, the repo config, git, the change list, a placeholders or mutants file, a pull request (unreadable, another repository's, or one that changes a lockfile), or the accepted store was wrong; nothing ran. */
  usage: 2,
  /** The run could not complete: tests fail before mutation, a prepare or spec command failed, the engine failed. */
  failed: 3,
  interrupted: 130,
} as const;

type ErrorClass = abstract new (...args: never[]) => Error;

/** Every expected error and its exit code; its message says enough. Anything else is a bug: exit 3, with its stack. */
const KNOWN: readonly (readonly [ErrorClass, number])[] = [
  [UsageError, EXIT.usage],
  [ConfigError, EXIT.usage],
  [GitError, EXIT.usage],
  [SuppressionStoreError, EXIT.usage],
  [ChangeListError, EXIT.usage],
  [MutantsFileError, EXIT.usage],
  [PullRequestError, EXIT.usage],
  [UnsupportedByRunnerError, EXIT.usage],
  [TestsFailBeforeMutationError, EXIT.failed],
  [PrepareError, EXIT.failed],
  [SpecCommandError, EXIT.failed],
  [EngineFailedError, EXIT.failed],
  [UninstrumentedError, EXIT.failed],
  [SandboxNotLoadedError, EXIT.failed],
  [MapFailedError, EXIT.failed],
  [InterruptedError, EXIT.interrupted],
];

/** A completed run: 1 when the report has findings (noise and accepted survivors are not findings), else 0. */
export function exitCodeOf(report: Pick<Report, 'findings'>): number {
  return report.findings.length > 0 ? EXIT.findings : EXIT.clean;
}

export function exitCodeFor(err: unknown): number {
  return KNOWN.find(([cls]) => err instanceof cls)?.[1] ?? EXIT.failed;
}

export function messageFor(err: unknown): string {
  if (err instanceof InterruptedError) return 'interrupted, engine runs stopped';
  if (KNOWN.some(([cls]) => err instanceof cls)) return (err as Error).message;
  if (err instanceof Error) return `weakspot failed: ${err.message}${err.stack ? `\n${err.stack.split('\n').slice(1).join('\n')}` : ''}`;
  return `weakspot failed: ${String(err)}`;
}
