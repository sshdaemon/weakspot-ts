import type { ChangeList } from '../change/change-list.ts';
import type { ChangeQuery, ChangeSource } from '../ports/change-source.ts';
import { checkListedFilesExist } from './change-list-input.ts';
import { type PipelineInput, resolveInsideRepo, runPipeline } from './pipeline.ts';

export interface DiffCommandInput extends Omit<PipelineInput, 'changed' | 'change' | 'specs'> {
  readonly source: ChangeSource;
  readonly base: string;
  readonly scope: ChangeQuery['scope'];
  readonly specs: readonly string[];
  readonly baseDir: string;
  /** A change list file the caller wrote; replaces git diff. */
  readonly changeList?: { readonly list: ChangeList; readonly file: string };
}

export async function diffCommand(input: DiffCommandInput) {
  const specs = resolveInsideRepo(input.repoRoot, input.baseDir, input.specs, 'spec');
  if (input.changeList) {
    const { list, file } = input.changeList;
    input.source.verifyHead(input.repoRoot, list.head, list.files.map((f) => f.path));
    checkListedFilesExist(input.repoRoot, list, file);
    input.log(`${list.files.length} changed file(s) from ${file} (${list.base}..${list.head})`);
    return await runPipeline({ ...input, changed: list.files, specs, change: { kind: 'changes', detail: `${list.base}..${list.head}, from ${file}` } });
  }
  const changed = input.source.changes({ repoRoot: input.repoRoot, base: input.base, scope: input.scope });
  input.log(`${changed.length} changed file(s) against ${input.base} (${input.scope})`);
  return await runPipeline({ ...input, changed, specs, change: { kind: 'diff', detail: `${input.base}, ${input.scope}` } });
}
