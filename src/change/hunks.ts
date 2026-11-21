import type { ChangedFile, FileStatus, LineRange } from './types.ts';

/**
 * Reads `git diff -U0 --no-color --find-renames` output into changed files with the line ranges that
 * were added or modified on the new side (a renamed file under its new path), and the text each hunk
 * removed. A file whose hunks only remove lines comes back with no ranges; deleted files never appear.
 */
export function parseUnifiedDiff(text: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let path: string | undefined;
  let status: FileStatus = 'modified';
  let ranges: LineRange[] = [];
  let removed: string[] = [];
  let hunkRemoved: string[] = [];
  // Header lines (`---`, `+++`) are only read between `diff --git` and the first `@@`; a content
  // line starting with `++ ` inside a hunk is not a header.
  let inHeader = false;
  const closeHunk = () => {
    if (hunkRemoved.length > 0) removed.push(hunkRemoved.join('\n'));
    hunkRemoved = [];
  };
  const flush = () => {
    closeHunk();
    if (path && (ranges.length > 0 || removed.length > 0)) files.push(removed.length > 0 ? { path, status, ranges, removed } : { path, status, ranges });
    path = undefined;
    status = 'modified';
    ranges = [];
    removed = [];
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
      closeHunk();
      inHeader = false;
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m || !m[1]) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      if (count > 0 && path) ranges.push({ start, end: start + count - 1 });
    } else if (!inHeader && path && line.startsWith('-')) {
      hunkRemoved.push(line.slice(1));
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
    // By code point, so a character outside the BMP (an emoji) is not split into lone surrogates.
    const c = String.fromCodePoint(inner.codePointAt(i)!);
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      i += c.length - 1;
      continue;
    }
    const n = inner[i + 1] ?? '';
    if (/[0-7]/.test(n)) {
      const oct = inner.slice(i + 1, i + 4);
      bytes.push(parseInt(oct, 8));
      i += 3;
    } else {
      const map: Record<string, number> = { n: 10, t: 9, r: 13, b: 8, f: 12, a: 7, v: 11, '\\': 92, '"': 34 };
      bytes.push(map[n] ?? n.codePointAt(0) ?? 0);
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}
