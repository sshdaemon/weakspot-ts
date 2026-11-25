import type { parseArgs } from 'node:util';
import { parseLaneSelection, type LaneSelection } from '../mutation/lanes.ts';
import type { ChangeQuery } from '../ports/change-source.ts';
import { escalateMode, positiveInt, type ToolConfig } from './config.ts';
import { isAcceptableId } from '../report/suppressions.ts';
import { UsageError } from './pipeline.ts';

export const USAGE = `weakspot <command> [options]

Commands
  diff                          mutate what changed against the base branch (committed, staged, unstaged and untracked)
  files <path[:start-end]>...   mutate the given files (or line ranges)
  propose [<path[:start-end]>...]
                                write placeholders.json for model-written mutants: the changed lines (or the given files)
                                where an author may change a condition, loop header, call or returned value
  run --mutants <file>          run an author's mutants against placeholders.json and merge them into report.json
  accept <id> --reason <text>   stop reporting a survivor or an untested file (ids are in report.json findings)
  accept <id> --revoke          report it again

Options
  --repo <dir>        repo root; relative paths are resolved against it (default: found from the cwd or the first file)
  --base <ref>        diff: ref to compare with (default: the repo config's base, else the remote's default branch)
  --changes <file>    diff: read the changed files and lines from a change list file instead of git diff
  --staged            diff: only committed and staged changes
  --committed         diff: only committed changes
  --specs <a,b>       spec files to run in the unit lane, instead of import discovery (repeatable)
  --depth <1|2>       import hops between a spec and a source that still count (default from config, 1)
  --lanes <a,b|all>   run the named lanes (or all) for every file, instead of later lanes taking only what the unit lane left untested
  --escalate <mode>   untested, noCoverage or survivors: which unit-lane survivors to retry in the next lane (default from config, untested)
  --out <dir>         where to write report.json and report.md (default: ~/.weakspot/runs/<repo>/<time>; for run, the placeholders file's folder)
  --timeout-ms <n>    per-mutant time limit for every lane (default from config, 3000)
  --concurrency <n>   engine worker count for every lane (default: cores, max 8)
  --exclude <a,b>     mutator names to switch off (replaces the config list)
  --quiet             only print the final summary
  --mutants <file>    run: the author's answers, { "mutants": [{ "placeholder", "replacement", "because" }] }
  --placeholders <f>  run: the placeholders file (default: placeholders.json next to --mutants)
  --reason <text>     accept: why the survivor or untested file is fine as is
  --revoke            accept: remove an earlier acceptance
`;

export const OPTIONS = {
  repo: { type: 'string' },
  base: { type: 'string' },
  changes: { type: 'string' },
  staged: { type: 'boolean' },
  committed: { type: 'boolean' },
  specs: { type: 'string', multiple: true },
  depth: { type: 'string' },
  lanes: { type: 'string' },
  escalate: { type: 'string' },
  out: { type: 'string' },
  'timeout-ms': { type: 'string' },
  concurrency: { type: 'string' },
  exclude: { type: 'string' },
  quiet: { type: 'boolean' },
  mutants: { type: 'string' },
  placeholders: { type: 'string' },
  reason: { type: 'string' },
  revoke: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

export type Flags = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];

const COMMANDS = new Set(['files', 'diff', 'propose', 'run', 'accept']);

/** Flags that only a run of operator mutants reads. */
const ENGINE_ONLY = ['escalate', 'exclude', 'timeout-ms', 'concurrency'] as const;

/** Refuses commands, paths and flags that do not fit together. */
export function checkUsage(command: string, rest: readonly string[], values: Flags): void {
  if (!COMMANDS.has(command)) throw new UsageError(`unknown command ${command}\n${USAGE}`);
  if (command === 'accept') {
    checkAcceptUsage(rest, values);
    return;
  }
  if (command === 'run') {
    checkRunUsage(rest, values);
    return;
  }
  if (values.reason !== undefined || values.revoke) throw new UsageError('--reason and --revoke apply to accept only');
  if (values.mutants !== undefined || values.placeholders !== undefined) throw new UsageError('--mutants and --placeholders apply to run only');
  if (command === 'propose') {
    const engine = ENGINE_ONLY.filter((k) => values[k] !== undefined);
    if (engine.length > 0) throw new UsageError(`propose runs no tests: ${engine.map((k) => `--${k}`).join(', ')} do not apply`);
  }
  if (values.lanes !== undefined && values.escalate !== undefined && values.escalate !== 'untested') {
    throw new UsageError('--escalate retries survivors in the next lane, which --lanes already ran for every file; use one or the other');
  }
  if (command === 'files' && rest.length === 0) throw new UsageError('files: give at least one path');
  if (command === 'diff' && rest.length > 0) throw new UsageError(`diff takes no paths; use --repo to point at a checkout`);
  if (values.staged && values.committed) throw new UsageError('--staged and --committed exclude each other');
  const named = command === 'files' || (command === 'propose' && rest.length > 0);
  if (named && (values.base || values.staged || values.committed || values.changes)) throw new UsageError('--base, --staged, --committed and --changes apply to diff only, not to named files');
  if (values.changes !== undefined && (values.base || values.staged || values.committed)) {
    throw new UsageError('--changes names the base and lines itself; drop --base, --staged and --committed');
  }
}

function checkRunUsage(rest: readonly string[], values: Flags): void {
  if (rest.length > 0) throw new UsageError('run takes no paths; pass the answers with --mutants');
  if (!values.mutants) throw new UsageError('run: --mutants <file> is required');
  const others = Object.keys(values).filter((k) => !['repo', 'mutants', 'placeholders', 'out', 'quiet', 'timeout-ms', 'concurrency'].includes(k));
  if (others.length > 0) throw new UsageError(`run: ${others.map((k) => `--${k}`).join(', ')} do not apply`);
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
    escalate: values.escalate === undefined ? loaded.escalate : escalateMode(values.escalate, '--escalate', 'command line'),
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

function checkAcceptUsage(rest: readonly string[], values: Flags): void {
  if (rest.length !== 1) throw new UsageError('accept: give exactly one id, from report.json findings');
  if (!isAcceptableId(rest[0]!)) throw new UsageError(`accept: ${rest[0]} is not a survivor id (<file>#<mutator>#<hash>) or <file>#untested`);
  if (values.revoke && values.reason !== undefined) throw new UsageError('accept: --revoke takes no --reason');
  if (!values.revoke && !values.reason?.trim()) throw new UsageError('accept: --reason is required, so the decision can be read later');
  const others = Object.keys(values).filter((k) => !['repo', 'reason', 'revoke', 'quiet'].includes(k));
  if (others.length > 0) throw new UsageError(`accept: ${others.map((k) => `--${k}`).join(', ')} do not apply`);
}
