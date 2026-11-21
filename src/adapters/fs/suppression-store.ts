import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SuppressionStore } from '../../ports/suppression-store.ts';
import type { AcceptedEntry } from '../../report/suppressions.ts';

export class SuppressionStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SuppressionStoreError';
  }
}

/** `{ "entries": [...] }` in one file; written to a temporary file and renamed, so a reader never sees half of it. */
export class JsonSuppressionStore implements SuppressionStore {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  list(repo: string): AcceptedEntry[] {
    return this.read().filter((e) => e.repo === repo);
  }

  accept(entry: AcceptedEntry): void {
    this.write([...this.read().filter((e) => !(e.repo === entry.repo && e.id === entry.id)), entry]);
  }

  revoke(repo: string, id: string): boolean {
    const all = this.read();
    const kept = all.filter((e) => !(e.repo === repo && e.id === id));
    if (kept.length === all.length) return false;
    this.write(kept);
    return true;
  }

  /** A malformed store is an error, not an empty list: silently dropping decisions would raise them all again. */
  private read(): AcceptedEntry[] {
    if (!existsSync(this.file)) return [];
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (err) {
      throw new SuppressionStoreError(`${this.file}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
    }
    const entries = (raw as { entries?: unknown }).entries;
    if (!Array.isArray(entries) || entries.some((e) => !isEntry(e))) throw new SuppressionStoreError(`${this.file}: expected { "entries": [{ repo, id, reason, date }] }`);
    return entries as AcceptedEntry[];
  }

  private write(entries: readonly AcceptedEntry[]): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ entries }, null, 2)}\n`);
    renameSync(tmp, this.file);
  }
}

function isEntry(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  return ['repo', 'id', 'reason', 'date'].every((k) => typeof o[k] === 'string');
}
