import { label } from './price';

/** One intermediate module between price.ts and format.test.ts, for depth-2 discovery. */
export function priceLine(name: string, pence: number): string {
  return `${name}: ${label(pence)}`;
}
