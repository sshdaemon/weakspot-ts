// Module-level code: its mutants are static (no per-test coverage, run against every test).
export const LIMIT = process.env['LIMIT_HIGH'] === 'yes' ? 100 : 50;
