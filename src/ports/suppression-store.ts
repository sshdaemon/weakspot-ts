import type { AcceptedEntry } from '../report/suppressions.ts';

/** Where accepted survivors are kept. A JSON file under the tool's home today. */
export interface SuppressionStore {
  list(repo: string): AcceptedEntry[];
  /** Adds the entry, replacing one with the same repo and id. */
  accept(entry: AcceptedEntry): void;
  /** Removes the entry; false when there was none. */
  revoke(repo: string, id: string): boolean;
}
