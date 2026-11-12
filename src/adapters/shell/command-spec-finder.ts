import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { isInside, repoRelative } from '../../change/paths.ts';
import type { Package, SpecSet } from '../../change/types.ts';
import type { SpecFinder } from '../../ports/spec-finder.ts';

export class SpecCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecCommandError';
  }
}

/**
 * A client command that prints the specs for a file, one repo-relative path per line. `{file}`
 * in the command is the repo-relative path (shell-quoted); without it the path is the last
 * argument. Runs in the repo root. A non-zero exit fails the run: a broken mapping must not pass
 * as "untested". Only existing files inside the file's package count.
 */
export class CommandSpecFinder implements SpecFinder {
  private readonly command: string;

  constructor(command: string) {
    this.command = command;
  }

  find(repoRoot: string, pkg: Package, file: string): SpecSet {
    const quoted = `'${file.replace(/'/g, `'\\''`)}'`;
    const cmd = this.command.includes('{file}') ? this.command.split('{file}').join(quoted) : `${this.command} ${quoted}`;
    const run = spawnSync('sh', ['-c', cmd], { cwd: repoRoot, encoding: 'utf8', env: process.env });
    if (run.error) throw new SpecCommandError(`spec command failed to start: ${run.error.message}`);
    if (run.status !== 0) throw new SpecCommandError(`spec command exited with ${run.status} for ${file}: ${cmd}\n${(run.stderr || run.stdout).trim()}`);
    const specs = [...new Set(run.stdout.split('\n').map((l) => l.trim()).filter(Boolean))]
      .map((p) => path.resolve(repoRoot, p))
      .filter((abs) => existsSync(abs) && isInside(pkg.dir, abs))
      .map((abs) => repoRelative(repoRoot, abs))
      .sort();
    return { file, specs, how: specs.length > 0 ? 'command' : 'none' };
  }
}
