import type { Report } from './types.ts';

export function renderMarkdown(r: Report): string {
  const lines: string[] = [];
  lines.push(`# weakspot report`, ``, `Repo: ${r.repo}  `, `Run: ${r.createdAt}  `, `Command: \`${r.command}\``, ``);
  lines.push(`## Packages`, ``);
  lines.push(`| Package | Files | Specs | Tests | Mutants | Killed | Survived | No coverage | Timeout | Errors | Ignored | Time |`);
  lines.push(`| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
  for (const p of r.packages) {
    const c = p.counts;
    const total = Object.values(c).reduce((a, b) => a + b, 0);
    const errors = (c['CompileError'] ?? 0) + (c['RuntimeError'] ?? 0);
    lines.push(
      `| ${p.name} | ${p.targets.length} | ${p.specs.length} | ${p.testCount} | ${total} | ${c['Killed'] ?? 0} | ${c['Survived'] ?? 0} | ${c['NoCoverage'] ?? 0} | ${c['Timeout'] ?? 0} | ${errors} | ${c['Ignored'] ?? 0} | ${(p.durationMs / 1000).toFixed(1)}s |`,
    );
  }
  if (r.untested.length > 0) {
    lines.push(``, `## Untested (no spec found, not mutated)`, ``, ...r.untested.map((f) => `- ${f}`));
  }
  if (r.noTestConfig.length > 0) {
    lines.push(``, `## No test config found`, ``, ...r.noTestConfig.map((f) => `- ${f}`));
  }
  if (r.warnings.length > 0) {
    lines.push(``, `## Warnings`, ``, ...r.warnings.map((w) => `- ${w}`));
  }
  if (r.dropped.length > 0) {
    lines.push(``, `## Skipped by triage`, ``, ...r.dropped.map((d) => `- ${d.path}: ${d.reason}`));
  }
  lines.push(``, `## Survivors (${r.survivors.length})`, ``);
  if (r.survivors.length === 0) lines.push(`None.`);
  const byFile = new Map<string, typeof r.survivors>();
  for (const s of r.survivors) byFile.set(s.mutant.file, [...(byFile.get(s.mutant.file) ?? []), s]);
  for (const [file, list] of byFile) {
    lines.push(`### ${file}`, ``);
    for (const { mutant: m, kind } of list) {
      const cov =
        kind === 'static' ? 'static: every test ran against it, none fails' : kind === 'noCoverage' ? 'no test reaches this line' : `${m.coveredBy} covering test(s), none fails`;
      lines.push(`- L${m.start.line}:${m.start.column} ${m.mutator} → \`${m.replacement.replace(/\s+/g, ' ').trim() || '(removed)'}\` (${cov})`);
    }
    lines.push(``);
  }
  return lines.join('\n');
}
