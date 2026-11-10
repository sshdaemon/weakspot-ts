import type { LineRange as Range } from './types.ts';

export const LineRange = {
  of(start: number, end: number): Range {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
      throw new Error(`invalid line range ${start}-${end}`);
    }
    return { start, end };
  },
  overlaps(a: Range, b: Range): boolean {
    return a.start <= b.end && b.start <= a.end;
  },
  /** Sorts and merges touching or overlapping ranges. */
  merge(ranges: readonly Range[]): Range[] {
    const sorted = [...ranges].sort((x, y) => x.start - y.start);
    const out: Range[] = [];
    for (const r of sorted) {
      const last = out.at(-1);
      if (last && r.start <= last.end + 1) {
        out[out.length - 1] = { start: last.start, end: Math.max(last.end, r.end) };
      } else {
        out.push(r);
      }
    }
    return out;
  },
  format(r: Range): string {
    return `${r.start}-${r.end}`;
  },
};

/** Parses `path`, `path:12-40` or `path:12` (one line). */
export function parseFileArg(arg: string): { path: string; ranges: Range[] | 'whole' } {
  const m = /^(.*?):(\d+)(?:-(\d+))?$/.exec(arg);
  if (!m || !m[1] || !m[2]) return { path: arg, ranges: 'whole' };
  const start = Number(m[2]);
  const end = m[3] ? Number(m[3]) : start;
  return { path: m[1], ranges: [LineRange.of(start, end)] };
}
