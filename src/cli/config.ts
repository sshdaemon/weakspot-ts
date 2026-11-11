import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SPEC_PATTERNS, type SpecPatterns } from '../change/spec-kind.ts';
import { DEFAULT_SKIP } from '../change/triage.ts';

export interface ToolConfig extends SpecPatterns {
  /** Ref a change is compared to, for example `origin/develop`. Default: the remote's default branch. */
  readonly base?: string;
  /** How many import hops between a spec and a source still count (1 or 2). */
  readonly specDepth: number;
  readonly skip: readonly string[];
  readonly excludedMutations: readonly string[];
  readonly timeoutMs: number;
  readonly concurrency: number;
  /** Extra options for the engine's vitest runner plugin, for example `{ "pool": "forks" }`. */
  readonly vitest: Record<string, unknown>;
}

export const DEFAULTS: ToolConfig = {
  ...DEFAULT_SPEC_PATTERNS,
  specDepth: 1,
  skip: DEFAULT_SKIP,
  excludedMutations: ['StringLiteral', 'ObjectLiteral', 'BlockStatement'],
  timeoutMs: 3000,
  concurrency: Math.max(1, Math.min(8, os.cpus().length)),
  vitest: {},
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function weakspotHome(): string {
  return process.env['WEAKSPOT_HOME'] ?? path.join(os.homedir(), '.weakspot');
}

/**
 * Tool defaults merged with `~/.weakspot/repos/<name>.json` when it exists. `name` is the
 * repository's name from its origin remote, so worktrees share the config; the checkout folder's
 * basename is tried when there is no remote.
 */
export function loadConfig(repoRoot: string, remoteName: string | undefined): { config: ToolConfig; source: string } {
  const names = [...new Set([remoteName, path.basename(repoRoot)].filter((n): n is string => Boolean(n)))];
  const file = names.map((n) => path.join(weakspotHome(), 'repos', `${n}.json`)).find((f) => existsSync(f));
  if (!file) return { config: DEFAULTS, source: 'defaults' };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`${file}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  return { config: validate(raw, file), source: file };
}

export function validate(raw: unknown, source: string): ToolConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError(`${source}: expected a JSON object`);
  const user = raw as Record<string, unknown>;
  const skip = stringList(user['skip'], 'skip', source) ?? DEFAULTS.skip;
  for (const s of skip) checkRegex(s, 'skip pattern', source);
  const specPattern = optionalString(user['specPattern'], 'specPattern', source) ?? DEFAULTS.specPattern;
  const e2ePattern = optionalString(user['e2ePattern'], 'e2ePattern', source) ?? DEFAULTS.e2ePattern;
  checkRegex(specPattern, 'specPattern', source);
  checkRegex(e2ePattern, 'e2ePattern', source);
  const base = user['base'];
  if (base !== undefined && (typeof base !== 'string' || !base.trim())) throw new ConfigError(`${source}: base must be a non-empty string`);
  const specDepth = positiveInt(user['specDepth'], 'specDepth', source) ?? DEFAULTS.specDepth;
  if (specDepth > 2) throw new ConfigError(`${source}: specDepth must be 1 or 2`);
  const vitest = user['vitest'];
  if (vitest !== undefined && (!vitest || typeof vitest !== 'object' || Array.isArray(vitest))) throw new ConfigError(`${source}: vitest must be an object`);
  return {
    ...(typeof base === 'string' ? { base } : {}),
    specPattern,
    e2ePattern,
    specDepth,
    skip,
    excludedMutations: stringList(user['excludedMutations'], 'excludedMutations', source) ?? DEFAULTS.excludedMutations,
    timeoutMs: positiveInt(user['timeoutMs'], 'timeoutMs', source) ?? DEFAULTS.timeoutMs,
    concurrency: positiveInt(user['concurrency'], 'concurrency', source) ?? DEFAULTS.concurrency,
    vitest: { ...DEFAULTS.vitest, ...((vitest as Record<string, unknown> | undefined) ?? {}) },
  };
}

/** Parses a numeric flag such as `--concurrency 4`; names the bad value in the error. */
export function positiveInt(value: unknown, name: string, source: string): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) throw new ConfigError(`${source}: ${name} must be a positive integer, got ${JSON.stringify(value)}`);
  return n;
}

function checkRegex(value: string, name: string, source: string): void {
  try {
    new RegExp(value);
  } catch (err) {
    throw new ConfigError(`${source}: ${name} ${JSON.stringify(value)} is not a valid regex (${err instanceof Error ? err.message : String(err)})`);
  }
}

function optionalString(value: unknown, name: string, source: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value) throw new ConfigError(`${source}: ${name} must be a non-empty string`);
  return value;
}

function stringList(value: unknown, name: string, source: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new ConfigError(`${source}: ${name} must be an array of strings`);
  return value as string[];
}
