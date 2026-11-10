import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SKIP } from '../change/triage.ts';

export interface ToolConfig {
  readonly skip: readonly string[];
  readonly excludedMutations: readonly string[];
  readonly timeoutMs: number;
  readonly concurrency: number;
  /** Extra options for the engine's vitest runner plugin, for example `{ "pool": "forks" }`. */
  readonly vitest: Record<string, unknown>;
}

export const DEFAULTS: ToolConfig = {
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

/** Tool defaults merged with `~/.weakspot/repos/<repo basename>.json` when it exists. */
export function loadConfig(repoRoot: string): { config: ToolConfig; source: string } {
  const file = path.join(weakspotHome(), 'repos', `${path.basename(repoRoot)}.json`);
  if (!existsSync(file)) return { config: DEFAULTS, source: 'defaults' };
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
  for (const s of skip) {
    try {
      new RegExp(s);
    } catch (err) {
      throw new ConfigError(`${source}: skip pattern ${JSON.stringify(s)} is not a valid regex (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  const vitest = user['vitest'];
  if (vitest !== undefined && (!vitest || typeof vitest !== 'object' || Array.isArray(vitest))) throw new ConfigError(`${source}: vitest must be an object`);
  return {
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

function stringList(value: unknown, name: string, source: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new ConfigError(`${source}: ${name} must be an array of strings`);
  return value as string[];
}
