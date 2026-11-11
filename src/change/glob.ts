/** Escapes glob metacharacters with bracket classes, so a literal `[id]` folder matches itself. */
export function escapeGlob(s: string): string {
  return s.replace(/[[\]{}()*?!]/g, (c) => `[${c}]`);
}
