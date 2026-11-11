export function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

export function isEven(n: number): boolean {
  return n % 2 === 0;
}
