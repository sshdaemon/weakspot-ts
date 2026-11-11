import { spawnSync } from 'node:child_process';

export class PrepareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrepareError';
  }
}

/** Runs a lane's prepare command through the shell in `cwd`; a non-zero exit is an error naming the command. */
export function runPrepare(command: string, cwd: string): string {
  const run = spawnSync('sh', ['-c', command], { cwd, encoding: 'utf8', env: process.env });
  if (run.error) throw new PrepareError(`prepare command failed to start in ${cwd}: ${run.error.message}`);
  if (run.status !== 0) throw new PrepareError(`prepare command exited with ${run.status} in ${cwd}: ${command}\n${(run.stderr || run.stdout).trim().split('\n').slice(-10).join('\n')}`);
  return run.stdout;
}
