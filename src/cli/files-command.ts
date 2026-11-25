import path from 'node:path';
import { parseFileArg } from '../change/ranges.ts';
import type { ChangedFile } from '../change/types.ts';
import { type PipelineInput, UsageError, resolveInsideRepo, runPipeline } from './pipeline.ts';

export { UsageError } from './pipeline.ts';

export interface FilesCommandInput extends Omit<PipelineInput, 'changed' | 'change' | 'specs'> {
  /** File arguments, `path` or `path:a-b`, relative to `baseDir`. */
  readonly files: readonly string[];
  readonly specs: readonly string[];
  /** What relative arguments resolve against: `--repo` when given, else the cwd. */
  readonly baseDir: string;
}

export async function filesCommand(input: FilesCommandInput) {
  return await runPipeline(filesPipelineInput(input));
}

/** The named files and ranges; shared by the mutation run and `propose`. */
export function filesPipelineInput(input: FilesCommandInput): PipelineInput {
  const parsed = input.files.map((arg) => {
    try {
      return parseFileArg(arg);
    } catch (err) {
      throw new UsageError(`${arg}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  const paths = resolveInsideRepo(input.repoRoot, input.baseDir, parsed.map((p) => p.path), 'file');
  const changed: ChangedFile[] = parsed.map((p, i) => ({ path: paths[i]!, status: 'modified', ranges: p.ranges }));
  const specs = resolveInsideRepo(input.repoRoot, input.baseDir, input.specs, 'spec');
  return { ...input, changed, specs, change: { kind: 'files', detail: parsed.map((p) => path.basename(p.path)).join(', ') } };
}
