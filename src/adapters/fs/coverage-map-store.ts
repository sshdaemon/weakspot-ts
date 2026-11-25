import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { COVERAGE_MAP_SCHEMA_VERSION, type CoverageMap } from '../../change/coverage-map.ts';
import type { CoverageMapStore } from '../../ports/coverage-map-store.ts';

/** `<dir>/<repo>/<lane>.json`, written to a temporary file and renamed. A map of another schema reads as none. */
export class JsonCoverageMapStore implements CoverageMapStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  read(repo: string, lane: string): CoverageMap | undefined {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.fileOf(repo, lane), 'utf8'));
    } catch {
      return undefined;
    }
    const m = raw as Partial<CoverageMap>;
    const shaped =
      m.schemaVersion === COVERAGE_MAP_SCHEMA_VERSION && typeof m.commit === 'string' && typeof m.createdAt === 'string' && !Number.isNaN(Date.parse(m.createdAt)) && Array.isArray(m.packages) && isSpecTable(m.specs) && (m.missing === undefined || Array.isArray(m.missing));
    return shaped ? (raw as CoverageMap) : undefined;
  }

  write(map: CoverageMap): string {
    const file = this.fileOf(map.repo, map.lane);
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(map, null, 1)}\n`);
    renameSync(tmp, file);
    return file;
  }

  private fileOf(repo: string, lane: string): string {
    return path.join(this.dir, repo.replaceAll(/[^\w.-]+/g, '_'), `${lane}.json`);
  }
}

function isSpecTable(v: unknown): boolean {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v) && Object.values(v as object).every((files) => Array.isArray(files));
}
