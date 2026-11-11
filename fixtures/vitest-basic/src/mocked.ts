// Mocked by mocked.test.ts: that spec never runs this code, so it is not this file's spec.
export function remote(n: number): number {
  return n > 10 ? n * 2 : n;
}
