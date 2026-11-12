import type { Package, SpecSet, TriageDecision } from '../change/types.ts';
import type { Lane } from './types.ts';

/** `fallback`: each file goes to the first lane with specs for it. `all` or a list: every named lane runs for every file. */
export type LaneSelection = 'fallback' | 'all' | readonly string[];

export interface LaneLookup {
  readonly lane: Lane;
  /** The package that owns the file with this lane's config, or undefined when it has none. */
  readonly packageOf: (file: string) => Package | undefined;
  readonly find: (pkg: Package, file: string) => SpecSet;
}

export interface LaneAssignment {
  readonly lane: Lane;
  readonly kept: TriageDecision[];
  readonly specs: Map<string, SpecSet>;
  readonly packages: Map<string, Package | undefined>;
}

export interface LaneOutcome {
  /** Names of the lanes that ran, in order. */
  readonly selected: string[];
  readonly assignments: LaneAssignment[];
  /** Files the first lane left untested that a later lane took. */
  readonly viaFallback: { file: string; lane: string }[];
  /** Kept files no selected lane has specs for. */
  readonly untested: string[];
  /** Per untested file, the lanes whose finder ran for it (a lane with no config in the file's package is left out). */
  readonly tried: Map<string, string[]>;
  /** Kept files no selected lane has a package with a config for. */
  readonly noTestConfig: string[];
}

export function parseLaneSelection(flag: string | undefined, names: readonly string[]): LaneSelection {
  if (flag === undefined) return 'fallback';
  if (flag === 'all') return 'all';
  const list = flag.split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) throw new Error('--lanes needs lane names or "all"');
  for (const name of list) if (!names.includes(name)) throw new Error(`unknown lane ${name}; configured: ${names.join(', ')}`);
  return list;
}

/**
 * Assigns kept files to lanes. Discovery runs lane by lane and only for files still unplaced,
 * so a later lane's command or mapping is not consulted for files the unit lane covers.
 */
export function assignLanes(kept: readonly TriageDecision[], lanes: readonly LaneLookup[], selection: LaneSelection): LaneOutcome {
  const selected = selection === 'fallback' || selection === 'all' ? lanes : lanes.filter((l) => selection.includes(l.lane.name));
  const assignments: LaneAssignment[] = selected.map((l) => ({ lane: l.lane, kept: [], specs: new Map(), packages: new Map() }));
  const outcome = { viaFallback: [] as LaneOutcome['viaFallback'], untested: [] as string[], tried: new Map<string, string[]>(), noTestConfig: [] as string[] };
  for (const d of kept) {
    const file = d.file.path;
    const { ran, hits } = lookUp(file, selected, selection === 'fallback');
    for (const hit of hits) {
      const a = assignments[hit.index]!;
      a.kept.push(d);
      a.specs.set(file, hit.set);
      a.packages.set(file, hit.pkg);
    }
    const first = hits[0];
    if (first && first.index > 0 && selection === 'fallback') outcome.viaFallback.push({ file, lane: selected[first.index]!.lane.name });
    if (first) continue;
    if (ran.length === 0) outcome.noTestConfig.push(file);
    else {
      outcome.untested.push(file);
      outcome.tried.set(file, ran);
    }
  }
  return { selected: selected.map((l) => l.lane.name), assignments: assignments.filter((a) => a.kept.length > 0), ...outcome };
}

/** Asks each lane in turn for the file's specs; `firstOnly` stops at the first lane that has some. `ran` names the lanes whose finder ran. */
function lookUp(file: string, lanes: readonly LaneLookup[], firstOnly: boolean): { ran: string[]; hits: { index: number; pkg: Package; set: SpecSet }[] } {
  const ran: string[] = [];
  const hits: { index: number; pkg: Package; set: SpecSet }[] = [];
  for (const [index, lookup] of lanes.entries()) {
    const pkg = lookup.packageOf(file);
    if (!pkg) continue;
    ran.push(lookup.lane.name);
    const set = lookup.find(pkg, file);
    if (set.specs.length === 0) continue;
    hits.push({ index, pkg, set });
    if (firstOnly) break;
  }
  return { ran, hits };
}
