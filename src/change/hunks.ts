import type { ChangedFile, FileStatus, LineRange } from './types.ts';

/**
 * Reads `git diff -U0 --no-color --find-renames` output into changed files with the line ranges that
 * were added or modified on the new side (a renamed file under its new path). Pure deletions have
 * no new-side lines and are dropped; deleted files never appear.
 */
export function parseUnifiedDiff(text: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let path: string | undefined;
  let status: FileStatus = 'modified';
  let ranges: LineRange[] = [];
  // Header lines (`---`, `+++`) are only read between `diff --git` and the first `@@`; a content
  // line starting with `++ ` inside a hunk is not a header.
  let inHeader = false;
  const flush = () => {
    if (path && ranges.length > 0) files.push({ path, status, ranges });
    path = undefined;
    status = 'modified';
    ranges = [];
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      inHeader = true;
      continue;
    }
    if (inHeader && line.startsWith('new file mode')) status = 'added';
    else if (inHeader && line.startsWith('deleted file mode')) path = undefined;
    else if (inHeader && line.startsWith('+++ ')) {
      const target = unquote(line.slice(4).replace(/\t.*$/, '').trim());
      path = target === '/dev/null' ? undefined : target.replace(/^b\//, '');
    } else if (line.startsWith('@@ ')) {
      inHeader = false;
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m || !m[1]) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      if (count > 0 && path) ranges.push({ start, end: start + count - 1 });
    }
  }
  flush();
  return files;
}

/** Git quotes paths with special characters C-style (`"a\tb"`, `"caf\303\251"`); this reverses it. */
export function unquote(s: string): string {
  if (!s.startsWith('"') || !s.endsWith('"')) return s;
  const inner = s.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const n = inner[i + 1] ?? '';
    if (/[0-7]/.test(n)) {
      const oct = inner.slice(i + 1, i + 4);
      bytes.push(parseInt(oct, 8));
      i += 3;
    } else {
      const map: Record<string, number> = { n: 10, t: 9, r: 13, b: 8, f: 12, a: 7, v: 11, '\\': 92, '"': 34 };
      bytes.push(map[n] ?? n.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}
