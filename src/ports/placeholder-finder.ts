import type { FoundPlaceholder } from '../mutation/model.ts';

/** Finds where model mutants may go and checks an answer fits. TypeScript's parser today. */
export interface PlaceholderFinder {
  /** Every placeholder of the file, in source order. `fileName` picks the dialect (`.tsx`). */
  find(fileName: string, text: string): FoundPlaceholder[];
  /** Why `replacement` cannot stand in for the placeholder in `text`, or undefined when it can. */
  misfit(fileName: string, text: string, placeholder: FoundPlaceholder, replacement: string): string | undefined;
}
