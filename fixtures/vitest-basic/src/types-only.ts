export interface LineRange {
  start: number;
  end: number;
}
export const unused = (r: LineRange): number => (r.end > r.start ? r.end - r.start : 0);
