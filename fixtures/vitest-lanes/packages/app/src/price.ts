export function discounted(pence: number, percent: number): number {
  if (percent <= 0) return pence;
  return Math.round(pence * (100 - percent) / 100);
}
