import type { ChangeQuery, ChangeSource } from '../ports/change-source.ts';
import { type PipelineInput, resolveInsideRepo, runPipeline } from './pipeline.ts';

export interface DiffCommandInput extends Omit<PipelineInput, 'changed' | 'change' | 'specs'> {
  readonly source: ChangeSource;
  readonly base: string;
  readonly scope: ChangeQuery['scope'];
  readonly specs: readonly string[];
  readonly baseDir: string;
}

export async function diffCommand(input: DiffCommandInput) {
  const changed = input.source.changes({ repoRoot: input.repoRoot, base: input.base, scope: input.scope });
  input.log(`${changed.length} changed file(s) against ${input.base} (${input.scope})`);
  const specs = resolveInsideRepo(input.repoRoot, input.baseDir, input.specs, 'spec');
  return runPipeline({ ...input, changed, specs, change: { kind: 'diff', detail: `${input.base}, ${input.scope}` } });
}
