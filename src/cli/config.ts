import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SPEC_PATTERNS, type SpecPatterns } from '../change/spec-kind.ts';
import { DEFAULT_SKIP } from '../change/triage.ts';
import { UNIT_TEST_CONFIGS } from '../adapters/fs/package-locator.ts';

/** How a lane names the specs for a file. Several may be listed; the first that yields specs wins. */
export type SpecSource = 'imports' | { readonly map: readonly (readonly [string, string])[] } | { readonly command: string };

export interface LaneConfig {
  readonly name: string;
  /** The runner config file name inside each package, for example `vitest-e2e.config.mts`. The unit lane uses the package's own. */
  readonly config?: string;
  readonly specs: readonly SpecSource[];
  readonly envPerWorker: Readonly<Record<string, string>>;
  readonly prepare?: string;
  readonly timeoutMs: number;
  readonly concurrency: number;
}

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
  /** The unit lane first, then the client's lanes in the order they fall back to each other. */
  readonly lanes: readonly LaneConfig[];
}

export const UNIT_LANE = 'unit';

const LIMITS = { timeoutMs: 3000, concurrency: Math.max(1, Math.min(8, os.cpus().length)) };

export const DEFAULTS: ToolConfig = {
  ...DEFAULT_SPEC_PATTERNS,
  specDepth: 1,
  skip: DEFAULT_SKIP,
  excludedMutations: ['StringLiteral', 'ObjectLiteral', 'BlockStatement'],
  ...LIMITS,
  vitest: {},
  lanes: [{ name: UNIT_LANE, specs: ['imports'], envPerWorker: {}, ...LIMITS }],
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
  const top = {
    ...(typeof base === 'string' ? { base } : {}),
    specPattern,
    e2ePattern,
    specDepth,
    skip,
    excludedMutations: stringList(user['excludedMutations'], 'excludedMutations', source) ?? DEFAULTS.excludedMutations,
    timeoutMs: positiveInt(user['timeoutMs'], 'timeoutMs', source) ?? DEFAULTS.timeoutMs,
    concurrency: positiveInt(user['concurrency'], 'concurrency', source) ?? DEFAULTS.concurrency,
    vitest: { ...DEFAULTS.vitest, ...(vitest as Record<string, unknown> | undefined) },
  };
  return { ...top, lanes: lanes(user['lanes'], top, source) };
}

type Limits = { timeoutMs: number; concurrency: number };

/**
 * `lanes` is an object keyed by lane name, in fallback order. The unit lane always exists and
 * comes first; an entry named `unit` may only change its limits, env and prepare command.
 */
function lanes(raw: unknown, top: Limits, source: string): LaneConfig[] {
  if (raw === undefined) return [unitLane(top, {}, source)];
  if (!isObject(raw)) throw new ConfigError(`${source}: lanes must be an object keyed by lane name`);
  const out: LaneConfig[] = [];
  for (const [name, value] of Object.entries(raw)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new ConfigError(`${source}: lane name ${JSON.stringify(name)} must be lowercase letters, digits and dashes`);
    if (!isObject(value)) throw new ConfigError(`${source}: lanes.${name} must be an object`);
    out.push(name === UNIT_LANE ? unitEntry(value, top, source) : laneEntry(name, value, out, top, source));
  }
  if (!out.some((l) => l.name === UNIT_LANE)) out.unshift(unitLane(top, {}, source));
  else if (out[0]!.name !== UNIT_LANE) throw new ConfigError(`${source}: the unit lane must be listed first; later lanes take the files it leaves untested`);
  return out;
}

function unitEntry(lane: Record<string, unknown>, top: Limits, source: string): LaneConfig {
  const fixed = ['config', 'specs'].find((key) => lane[key] !== undefined);
  if (fixed) throw new ConfigError(`${source}: lanes.unit.${fixed} cannot be set; the unit lane uses the package's own config and import discovery`);
  return unitLane(top, lane, source);
}

/** A lane after the unit lane; `earlier` are the lanes already read, which may not share its config. */
function laneEntry(name: string, lane: Record<string, unknown>, earlier: readonly LaneConfig[], top: Limits, source: string): LaneConfig {
  const config = optionalString(lane['config'], `lanes.${name}.config`, source);
  if (!config) throw new ConfigError(`${source}: lanes.${name}.config is required (the runner config file name inside each package)`);
  if (config.includes('/') || config.includes('\\')) throw new ConfigError(`${source}: lanes.${name}.config must be a file name, not a path`);
  if (UNIT_TEST_CONFIGS.includes(config)) throw new ConfigError(`${source}: lanes.${name}.config ${JSON.stringify(config)} is the unit lane's config; a lane needs its own`);
  const twin = earlier.find((l) => l.config === config);
  if (twin) throw new ConfigError(`${source}: lanes.${name} and lanes.${twin.name} share the config ${JSON.stringify(config)}; each lane needs its own`);
  const specs = specSources(lane['specs'], `lanes.${name}.specs`, source);
  if (specs.length === 0) throw new ConfigError(`${source}: lanes.${name}.specs is required ("imports", { "map": [[regex, glob]] } or { "command": "..." })`);
  return { name, config, specs, ...laneLimits(lane, `lanes.${name}`, top, source) };
}

function unitLane(top: Limits, lane: Record<string, unknown>, source: string): LaneConfig {
  return { name: UNIT_LANE, specs: ['imports'], ...laneLimits(lane, 'lanes.unit', top, source) };
}

function laneLimits(lane: Record<string, unknown>, prefix: string, top: Limits, source: string) {
  const env = lane['envPerWorker'];
  if (env !== undefined && !isStringRecord(env)) throw new ConfigError(`${source}: ${prefix}.envPerWorker must be an object of string values`);
  const prepare = optionalString(lane['prepare'], `${prefix}.prepare`, source);
  return {
    envPerWorker: { ...env },
    ...(prepare ? { prepare } : {}),
    timeoutMs: positiveInt(lane['timeoutMs'], `${prefix}.timeoutMs`, source) ?? top.timeoutMs,
    concurrency: positiveInt(lane['concurrency'], `${prefix}.concurrency`, source) ?? top.concurrency,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((v) => typeof v === 'string');
}

function specSources(raw: unknown, name: string, source: string): SpecSource[] {
  if (raw === undefined) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((item): SpecSource => {
    if (item === 'imports') return 'imports';
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const o = item as Record<string, unknown>;
      if (Array.isArray(o['map'])) {
        const map = o['map'].map((pair): readonly [string, string] => {
          if (!Array.isArray(pair) || pair.length !== 2 || pair.some((p) => typeof p !== 'string')) throw new ConfigError(`${source}: ${name}.map entries are [regex, glob] pairs`);
          checkRegex(pair[0] as string, `${name}.map regex`, source);
          return [pair[0] as string, pair[1] as string];
        });
        return { map };
      }
      if (typeof o['command'] === 'string' && o['command'].trim()) return { command: o['command'] };
    }
    throw new ConfigError(`${source}: ${name} entries are "imports", { "map": [[regex, glob]] } or { "command": "..." }, got ${JSON.stringify(item)}`);
  });
}

/** Parses a numeric flag such as `--concurrency 4`; names the bad value in the error. */
export function positiveInt(value: unknown, name: string, source: string): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) throw new ConfigError(`${source}: ${name} must be a positive integer, got ${JSON.stringify(value)}`);
  return n;
}

/** The compiled pattern; throws a ConfigError naming the field when it does not compile. */
function checkRegex(value: string, name: string, source: string): RegExp {
  try {
    return new RegExp(value);
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
