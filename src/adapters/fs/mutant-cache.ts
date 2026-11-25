import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CachedMutant } from '../../mutation/model.ts';
import type { MutantCache } from '../../ports/mutant-cache.ts';

type Entries = Record<string, readonly CachedMutant[]>;

/**
 * One JSON file per repository under `dir`. A cache only saves authoring work, so a file that is
 * missing or unreadable counts as empty and the next write replaces it.
 */
export class JsonMutantCache implements MutantCache {
  private readonly dir: string;
  private readonly loaded = new Map<string, Entries>();

  constructor(dir: string) {
    this.dir = dir;
  }

  get(repo: string, placeholder: string): readonly CachedMutant[] | undefined {
    return this.read(repo)[placeholder];
  }

  put(repo: string, entries: ReadonlyMap<string, readonly CachedMutant[]>): void {
    if (entries.size === 0) return;
    const next: Entries = { ...this.read(repo), ...Object.fromEntries(entries) };
    mkdirSync(this.dir, { recursive: true });
    const file = this.fileOf(repo);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, file);
    this.loaded.set(repo, next);
  }

  private read(repo: string): Entries {
    const hit = this.loaded.get(repo);
    if (hit) return hit;
    let entries: Entries = {};
    try {
      const raw: unknown = JSON.parse(readFileSync(this.fileOf(repo), 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) entries = Object.fromEntries(Object.entries(raw).filter(([, v]) => Array.isArray(v) && v.every(isCached))) as Entries;
    } catch {
      // missing or unreadable: start empty
    }
    this.loaded.set(repo, entries);
    return entries;
  }

  private fileOf(repo: string): string {
    return path.join(this.dir, `${repo.replaceAll(/[^\w.-]+/g, '_')}.json`);
  }
}

function isCached(v: unknown): boolean {
  return Boolean(v) && typeof v === 'object' && typeof (v as CachedMutant).replacement === 'string' && typeof (v as CachedMutant).because === 'string';
}
