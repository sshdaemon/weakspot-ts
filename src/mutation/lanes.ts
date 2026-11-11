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
  const viaFallback: LaneOutcome['viaFallback'] = [];
  const untested: string[] = [];
  const tried = new Map<string, string[]>();
  const noTestConfig: string[] = [];
  for (const d of kept) {
    const file = d.file.path;
    let placed = false;
    const ran: string[] = [];
    for (const [i, lookup] of selected.entries()) {
      if (placed && selection === 'fallback') break;
      const pkg = lookup.packageOf(file);
      if (!pkg) continue;
      ran.push(lookup.lane.name);
      const set = lookup.find(pkg, file);
      if (set.specs.length === 0) continue;
      const a = assignments[i]!;
      a.kept.push(d);
      a.specs.set(file, set);
      a.packages.set(file, pkg);
      if (!placed && i > 0 && selection === 'fallback') viaFallback.push({ file, lane: lookup.lane.name });
      placed = true;
    }
    if (placed) continue;
    if (ran.length === 0) noTestConfig.push(file);
    else {
      untested.push(file);
      tried.set(file, ran);
    }
  }
  return { selected: selected.map((l) => l.lane.name), assignments: assignments.filter((a) => a.kept.length > 0), viaFallback, untested, tried, noTestConfig };
}
