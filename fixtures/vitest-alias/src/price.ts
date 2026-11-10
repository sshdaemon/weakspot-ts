export function discounted(pence: number, percent: number): number {
  if (percent <= 0) return pence;
  if (percent >= 100) return 0;
  return Math.round(pence - (pence * percent) / 100);
}

/** Whole pounds without decimals, anything else with two. */
export function label(pence: number): string {
  if (pence % 100 === 0) return `£${pence / 100}`;
  return `£${(pence / 100).toFixed(2)}`;
}
