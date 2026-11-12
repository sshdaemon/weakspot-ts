import type { parseArgs } from 'node:util';
import { parseLaneSelection, type LaneSelection } from '../mutation/lanes.ts';
import type { ChangeQuery } from '../ports/change-source.ts';
import { positiveInt, type ToolConfig } from './config.ts';
import { UsageError } from './pipeline.ts';

export const USAGE = `weakspot <command> [options]

Commands
  diff                          mutate what changed against the base branch (committed, staged, unstaged and untracked)
  files <path[:start-end]>...   mutate the given files (or line ranges)

Options
  --repo <dir>        repo root; relative paths are resolved against it (default: found from the cwd or the first file)
  --base <ref>        diff: ref to compare with (default: the repo config's base, else the remote's default branch)
  --staged            diff: only committed and staged changes
  --committed         diff: only committed changes
  --specs <a,b>       spec files to run in the unit lane, instead of import discovery (repeatable)
  --depth <1|2>       import hops between a spec and a source that still count (default from config, 1)
  --lanes <a,b|all>   run the named lanes (or all) for every file, instead of later lanes taking only what the unit lane left untested
  --out <dir>         where to write report.json and report.md (default: ~/.weakspot/runs/<repo>/<time>)
  --timeout-ms <n>    per-mutant time limit for every lane (default from config, 3000)
  --concurrency <n>   engine worker count for every lane (default: cores, max 8)
  --exclude <a,b>     mutator names to switch off (replaces the config list)
  --quiet             only print the final summary
`;

export const OPTIONS = {
  repo: { type: 'string' },
  base: { type: 'string' },
  staged: { type: 'boolean' },
  committed: { type: 'boolean' },
  specs: { type: 'string', multiple: true },
  depth: { type: 'string' },
  lanes: { type: 'string' },
  out: { type: 'string' },
  'timeout-ms': { type: 'string' },
  concurrency: { type: 'string' },
  exclude: { type: 'string' },
  quiet: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

export type Flags = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];

/** Refuses commands, paths and flags that do not fit together. */
export function checkUsage(command: string, rest: readonly string[], values: Flags): void {
  if (command !== 'files' && command !== 'diff') throw new UsageError(`unknown command ${command}\n${USAGE}`);
  if (command === 'files' && rest.length === 0) throw new UsageError('files: give at least one path');
  if (command === 'diff' && rest.length > 0) throw new UsageError(`diff takes no paths; use --repo to point at a checkout`);
  if (values.staged && values.committed) throw new UsageError('--staged and --committed exclude each other');
  if (command === 'files' && (values.base || values.staged || values.committed)) throw new UsageError('--base, --staged and --committed apply to diff only');
}

/** The repo config with command-line flags applied; a limit flag applies to every lane. */
export function withFlags(loaded: ToolConfig, values: Flags): ToolConfig {
  const depth = positiveInt(values.depth, '--depth', 'command line') ?? loaded.specDepth;
  if (depth > 2) throw new UsageError('--depth must be 1 or 2');
  const timeoutMs = positiveInt(values['timeout-ms'], '--timeout-ms', 'command line');
  const concurrency = positiveInt(values.concurrency, '--concurrency', 'command line');
  return {
    ...loaded,
    specDepth: depth,
    timeoutMs: timeoutMs ?? loaded.timeoutMs,
    concurrency: concurrency ?? loaded.concurrency,
    excludedMutations: values.exclude ? values.exclude.split(',').filter(Boolean) : loaded.excludedMutations,
    lanes: loaded.lanes.map((l) => ({ ...l, timeoutMs: timeoutMs ?? l.timeoutMs, concurrency: concurrency ?? l.concurrency })),
  };
}

export function laneSelectionOf(values: Flags, config: ToolConfig): LaneSelection {
  let selection: LaneSelection;
  try {
    selection = parseLaneSelection(values.lanes, config.lanes.map((l) => l.name));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  if (values.specs && Array.isArray(selection) && !selection.includes('unit')) {
    throw new UsageError('--specs names specs for the unit lane; include unit in --lanes or drop --specs');
  }
  return selection;
}

export function scopeOf(values: Flags): ChangeQuery['scope'] {
  if (values.committed) return 'committed';
  if (values.staged) return 'staged';
  return 'working';
}
