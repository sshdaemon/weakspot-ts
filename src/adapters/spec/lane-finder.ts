import type { LaneConfig, ToolConfig } from '../../cli/config.ts';
import type { CoverageMapStore } from '../../ports/coverage-map-store.ts';
import type { SpecFinder } from '../../ports/spec-finder.ts';
import { CoverageSpecFinder } from './coverage-spec-finder.ts';
import { MapSpecFinder } from '../fs/map-spec-finder.ts';
import { CommandSpecFinder } from '../shell/command-spec-finder.ts';
import { ImportSpecFinder } from '../ts/import-spec-finder.ts';
import { FirstSpecFinder } from './first-spec-finder.ts';

/**
 * A lane's finder from its spec sources. `imports` in a lane after the unit lane means specs
 * matching the e2e pattern that import the file; the unit pattern's specs belong to the unit lane.
 * `coverage` reads the lane's coverage map for `cacheScope`, the repository key.
 */
export function laneFinder(lane: LaneConfig, config: Pick<ToolConfig, 'specDepth' | 'specPattern' | 'e2ePattern'>, cacheDir?: string, cacheScope?: string, maps?: CoverageMapStore): SpecFinder {
  const finders = lane.specs.map((source): SpecFinder => {
    if (source === 'imports') return new ImportSpecFinder(config.specDepth, config, 'e2e', cacheDir, cacheScope);
    if (source === 'coverage') {
      if (!maps || cacheScope === undefined) throw new Error(`lane ${lane.name} lists coverage, which needs a map store and the repository key`);
      return new CoverageSpecFinder(maps, cacheScope, lane.name);
    }
    if ('map' in source) return new MapSpecFinder(source.map);
    return new CommandSpecFinder(source.command);
  });
  return finders.length === 1 ? finders[0]! : new FirstSpecFinder(finders);
}
