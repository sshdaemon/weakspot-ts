import type { CoverageMap } from '../change/coverage-map.ts';

/** Coverage maps per repository and lane. */
export interface CoverageMapStore {
  /** The lane's map, or undefined when there is none or it cannot be read. */
  read(repo: string, lane: string): CoverageMap | undefined;
  /** Writes the map and returns where it went. */
  write(map: CoverageMap): string;
}
