import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { isInside } from '../../change/paths.ts';
import type { DependencyLinker } from '../../ports/dependency-linker.ts';

/**
 * For every package in the tree whose twin in the main checkout has `node_modules`: a real
 * `node_modules` folder of links, one per entry (a single link to the whole folder is dropped by the
 * engine's sandbox). An entry that is a workspace package links to that package in the tree, so the
 * tree's code is what gets imported; everything else links to the main checkout's install.
 */
export class NodeModulesLinker implements DependencyLinker {
  link(mainRoot: string, treeRoot: string): string[] {
    const main = realpathSync(mainRoot);
    const wired: string[] = [];
    for (const dir of packageDirs(treeRoot)) {
      const from = path.join(main, dir, 'node_modules');
      const to = path.join(treeRoot, dir, 'node_modules');
      if (!existsSync(from) || existsSync(to)) continue;
      mkdirSync(to);
      for (const name of readdirSync(from)) {
        const entry = path.join(from, name);
        if (name.startsWith('@') && lstatSync(entry).isDirectory()) {
          mkdirSync(path.join(to, name));
          for (const inner of readdirSync(entry)) linkEntry(path.join(entry, inner), path.join(to, name, inner), main, treeRoot);
        } else {
          linkEntry(entry, path.join(to, name), main, treeRoot);
        }
      }
      wired.push(dir || '.');
    }
    return wired;
  }
}

/**
 * The link's own target, read without following it, so a dangling link stays one and a workspace link
 * still maps into the tree when the main checkout's node_modules is itself a link elsewhere.
 */
function linkEntry(entry: string, dest: string, main: string, treeRoot: string): void {
  let target = entry;
  if (lstatSync(entry).isSymbolicLink()) {
    const resolved = path.resolve(path.dirname(entry), readlinkSync(entry));
    const rel = path.relative(main, resolved);
    if (isInside(main, resolved) && !rel.split(path.sep).includes('node_modules')) target = path.join(treeRoot, rel);
  }
  symlinkSync(target, dest);
}

/** Folders of the tree's tracked package.json files, repo-relative, the root as ''. */
function packageDirs(treeRoot: string): string[] {
  const files = execFileSync('git', ['-c', 'core.quotePath=false', 'ls-files', '--', 'package.json', '*/package.json'], { cwd: treeRoot, encoding: 'utf8' });
  return [...new Set(files.split('\n').filter(Boolean).map((f) => path.dirname(f)).map((d) => (d === '.' ? '' : d)))].toSorted();
}
