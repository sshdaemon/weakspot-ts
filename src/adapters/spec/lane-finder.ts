import type { LaneConfig, ToolConfig } from '../../cli/config.ts';
import type { SpecFinder } from '../../ports/spec-finder.ts';
import { MapSpecFinder } from '../fs/map-spec-finder.ts';
import { CommandSpecFinder } from '../shell/command-spec-finder.ts';
import { ImportSpecFinder } from '../ts/import-spec-finder.ts';
import { FirstSpecFinder } from './first-spec-finder.ts';

/**
 * A lane's finder from its spec sources. `imports` in a lane after the unit lane means specs
 * matching the e2e pattern that import the file; the unit pattern's specs belong to the unit lane.
 */
export function laneFinder(lane: LaneConfig, config: Pick<ToolConfig, 'specDepth' | 'specPattern' | 'e2ePattern'>): SpecFinder {
  const finders = lane.specs.map((source): SpecFinder => {
    if (source === 'imports') return new ImportSpecFinder(config.specDepth, config, 'e2e');
    if ('map' in source) return new MapSpecFinder(source.map);
    return new CommandSpecFinder(source.command);
  });
  return finders.length === 1 ? finders[0]! : new FirstSpecFinder(finders);
}
